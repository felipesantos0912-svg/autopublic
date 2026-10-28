import { Injectable, Logger } from '@nestjs/common';
import { generateText } from 'ai';
import {
  AiClientFactory,
  isReasoningModel,
} from '@gitroom/nestjs-libraries/ai/ai-client.factory';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { InstagramMessagingService } from '@gitroom/nestjs-libraries/integrations/social/instagram-messaging.service';
import { DmAgentState } from './dm-agent.state';
import type { DmHistoryEntry, DmProfile } from './dm-agent.state';
import {
  buildSystemPrompt,
  defaultHandoffMessage,
  describeNow,
  parseModelOutput,
  pickFirstName,
  validateMessages,
} from './dm-agent.logic';
import type {
  DmAgentAttachment,
  DmAgentRunInput,
  DmAgentRunResult,
} from './dm-agent.types';

const META_CDN_SUFFIXES = [
  '.cdninstagram.com',
  '.fbcdn.net',
  '.fbsbx.com',
  '.facebook.com',
  '.instagram.com',
];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function isMetaCdn(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      META_CDN_SUFFIXES.some(
        (s) => u.hostname === s.slice(1) || u.hostname.endsWith(s)
      )
    );
  } catch {
    return false;
  }
}

/** Baixa a imagem do CDN da Meta (link temporario) para mandar ao modelo. */
async function downloadImage(
  url: string
): Promise<{ data: Buffer; mediaType: string } | null> {
  if (!isMetaCdn(url)) return null;
  const t = withTimeout(15_000);
  try {
    const res = await fetch(url, { signal: t.signal });
    if (!res.ok) return null;
    const mediaType = (res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mediaType.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    return { data: buf, mediaType };
  } catch {
    return null;
  } finally {
    t.clear();
  }
}

function describeInbound(text: string, attachments: DmAgentAttachment[]): string {
  const bits: string[] = [];
  if (text) bits.push(text);
  const images = attachments.filter((a) => a.type === 'image').length;
  if (images) bits.push(images > 1 ? `[${images} fotos]` : '[foto]');
  if (attachments.length - images > 0) bits.push('[anexo]');
  return bits.join(' ') || '[mensagem]';
}

function historyToMessages(history: DmHistoryEntry[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const h of history) {
    const role = h.r === 'u' ? 'user' : 'assistant';
    const text = h.r === 'h' ? `(equipa da loja) ${h.t}` : h.t;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  // alguns provedores exigem que a primeira mensagem seja do usuario
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

@Injectable()
export class DmAgentService {
  private readonly _logger = new Logger(DmAgentService.name);

  constructor(
    private _aiFactory: AiClientFactory,
    private _messaging: InstagramMessagingService,
    private _integrationService: IntegrationService
  ) {}

  private async getProfile(
    integration: {
      id: string;
      organizationId: string;
      profileId?: string | null;
      internalId: string;
    },
    igsid: string
  ): Promise<DmProfile | null> {
    const cached = await DmAgentState.getProfile(integration.id, igsid);
    if (cached) return cached;
    const fresh = await this._messaging.fetchUserProfile({
      organizationId: integration.organizationId,
      profileId: integration.profileId || null,
      igBusinessAccountId: integration.internalId,
      igsid,
    });
    if (fresh) await DmAgentState.setProfile(integration.id, igsid, fresh);
    return fresh;
  }

  /**
   * Trata UMA mensagem direta recebida: pausa/limite -> contexto -> IA ->
   * validacao contra invencao -> (modo auto) envia. Em modo shadow nada e
   * enviado: devolve o que responderia, para a equipa conferir.
   */
  async run(input: DmAgentRunInput): Promise<DmAgentRunResult> {
    const { cfg, integrationId, organizationId, igSenderId, igMessageId } = input;

    if (!(await DmAgentState.claimMessage(igMessageId))) {
      return {
        status: 'skipped',
        note: 'mensagem já tratada (duplicada) ou Redis indisponível',
      };
    }

    let sentAny = false;
    try {
      const integration = await this._integrationService.getIntegrationById(
        organizationId,
        integrationId
      );
      if (!integration) {
        throw new Error(`Integration ${integrationId} not found`);
      }

      const inboundText = describeInbound(input.messageText, input.attachments);

      if (await DmAgentState.isPaused(integrationId, igSenderId)) {
        await DmAgentState.pushHistory(integrationId, igSenderId, {
          r: 'u',
          t: inboundText,
          ts: Date.now(),
        });
        return {
          status: 'paused',
          note: 'conversa pausada: a equipa assumiu ou o agente passou a bola',
        };
      }
      if (
        !(await DmAgentState.underRateLimit(
          integrationId,
          igSenderId,
          cfg.maxRepliesPerHour
        ))
      ) {
        return {
          status: 'skipped',
          note: 'limite de respostas por hora atingido para este cliente',
        };
      }

      const profile = await this.getProfile(integration, igSenderId);
      const firstName = pickFirstName(profile?.name);
      const now = new Date();
      const system = buildSystemPrompt(cfg, describeNow(cfg, now), firstName);

      // mensagem atual (texto + ate 2 fotos)
      const textBits: string[] = [];
      if (input.messageText) textBits.push(input.messageText);
      const imageParts: Array<Record<string, unknown>> = [];
      let imagesSeen = 0;
      for (const a of input.attachments) {
        if (a.type === 'image') {
          imagesSeen++;
          const img =
            imageParts.length < MAX_IMAGES ? await downloadImage(a.url) : null;
          if (img) {
            imageParts.push({
              type: 'image',
              image: img.data,
              mediaType: img.mediaType,
            });
          } else {
            textBits.push('[o cliente enviou uma foto que não consegui abrir]');
          }
        } else if (['share', 'ig_post', 'ig_reel', 'reel', 'story'].includes(a.type)) {
          textBits.push('[o cliente partilhou uma publicação ou story do Instagram, que não consigo abrir]');
        } else if (a.type === 'audio') {
          textBits.push('[o cliente enviou um áudio, que não consigo ouvir]');
        } else if (a.type === 'video') {
          textBits.push('[o cliente enviou um vídeo, que não consigo ver]');
        } else {
          textBits.push('[o cliente enviou um anexo que não consigo abrir]');
        }
      }
      if (!textBits.length && imagesSeen) textBits.push('[o cliente enviou uma foto]');

      const history = await DmAgentState.getHistory(integrationId, igSenderId, 16);
      const messages: Array<Record<string, unknown>> = historyToMessages(history);
      const lastPrev = messages[messages.length - 1] as
        | { role: string; content: string }
        | undefined;
      if (lastPrev && lastPrev.role === 'user') {
        textBits.unshift(lastPrev.content);
        messages.pop();
      }
      const userText = textBits.join('\n') || '[mensagem vazia]';
      const withImages = [
        ...messages,
        { role: 'user', content: [{ type: 'text', text: userText }, ...imageParts] },
      ];
      const withoutImages = [
        ...messages,
        {
          role: 'user',
          content: imageParts.length
            ? `${userText}\n[a foto não pôde ser processada]`
            : userText,
        },
      ];

      const client = await this._aiFactory.text(
        organizationId,
        integration.profileId || undefined
      );
      const attempts: Array<{ model: any; modelId: string; msgs: any[] }> = [
        { model: client.model, modelId: client.modelId, msgs: withImages },
      ];
      if (imageParts.length) {
        attempts.push({ model: client.model, modelId: client.modelId, msgs: withoutImages });
      }
      if (client.fallbackModel) {
        attempts.push({
          model: client.fallbackModel,
          modelId: client.fallbackModelId || '',
          msgs: withoutImages,
        });
      }

      let text: string | null = null;
      let lastError: unknown = null;
      for (const attempt of attempts) {
        const t = withTimeout(60_000);
        try {
          const result = await generateText({
            model: attempt.model,
            system,
            messages: attempt.msgs,
            maxOutputTokens: 600,
            ...(isReasoningModel(attempt.modelId) ? {} : { temperature: 0.4 }),
            abortSignal: t.signal,
          });
          text = result.text;
          break;
        } catch (e) {
          lastError = e;
          this._logger.warn(
            `dm-agent: falha ao gerar resposta (modelo ${attempt.modelId || '?'}): ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        } finally {
          t.clear();
        }
      }
      if (text === null) {
        throw lastError instanceof Error ? lastError : new Error('falha ao gerar resposta');
      }

      const out = parseModelOutput(text);
      let handoff = out.handoff;
      let reply = out.messages;
      let violations: string[] = [];
      if (reply.length) {
        const check = validateMessages(reply, cfg);
        violations = check.violations;
        if (!check.ok) {
          reply = [];
          handoff = true;
        }
      } else {
        handoff = true;
      }
      if (handoff) {
        reply = cfg.handoffMessage
          ? [cfg.handoffMessage]
          : reply.length
            ? reply
            : [defaultHandoffMessage(cfg, now)];
      }

      await DmAgentState.pushHistory(integrationId, igSenderId, {
        r: 'u',
        t: inboundText,
        ts: Date.now(),
      });

      if (cfg.mode !== 'auto') {
        return {
          status: 'shadow',
          proposed: reply,
          handoff,
          violations,
          note: handoff
            ? `modo sombra: nada foi enviado (chamaria a equipa${out.handoffReason ? `: ${out.handoffReason}` : ''})`
            : 'modo sombra: nada foi enviado',
        };
      }

      for (let i = 0; i < reply.length; i++) {
        await DmAgentState.rememberSent(integrationId, igSenderId, reply[i]);
        await this._messaging.sendStoryReply({
          organizationId: integration.organizationId,
          profileId: integration.profileId || null,
          igBusinessAccountId: integration.internalId,
          recipientIgsid: igSenderId,
          message: reply[i],
          integrationName: integration.name || undefined,
        });
        sentAny = true;
        await DmAgentState.pushHistory(integrationId, igSenderId, {
          r: 'a',
          t: reply[i],
          ts: Date.now(),
        });
        if (i < reply.length - 1) await sleep(900);
      }
      if (handoff) {
        await DmAgentState.pause(integrationId, igSenderId, cfg.pauseHours);
      }
      return {
        status: 'sent',
        sent: reply,
        handoff,
        violations,
        note: handoff ? 'enviou aviso e passou para a equipa (conversa pausada)' : undefined,
      };
    } catch (e) {
      if (!sentAny) await DmAgentState.releaseMessage(igMessageId);
      if (sentAny) {
        this._logger.error(
          `dm-agent: erro depois de enviar parte da resposta: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return { status: 'error', note: 'erro depois de enviar parte da resposta' };
      }
      throw e;
    }
  }
}
