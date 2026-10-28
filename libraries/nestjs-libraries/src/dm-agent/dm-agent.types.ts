export type DmAgentMode = 'shadow' | 'auto';

export type DmDayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

/**
 * Janelas de funcionamento por dia da semana. Cada janela e [abre, fecha] em
 * HH:mm no fuso do restaurante. Se fecha <= abre, a janela atravessa a
 * meia-noite (ex.: ["18:00", "01:00"]).
 */
export type DmAgentHours = Partial<Record<DmDayKey, Array<[string, string]>>>;

/** Configuracao do agente, guardada em `agent` dentro do `data` do no TRIGGER do flow dm_direct. */
export interface DmAgentConfig {
  enabled: boolean;
  /** shadow = so registra o que responderia (nada e enviado); auto = envia. */
  mode: DmAgentMode;
  businessName: string;
  assistantName?: string;
  timezone: string;
  hours?: DmAgentHours;
  /** Tom de voz e regras proprias do restaurante (texto livre). */
  persona?: string;
  /** Ficha do restaurante: UNICA fonte de verdade do agente (texto/markdown). */
  knowledge: string;
  /** Link para pedir (Glovo, cardapio digital...). O agente nunca tira pedido. */
  deliveryUrl?: string;
  /** Outros links que o agente pode enviar (alem dos que ja estao na ficha). */
  allowedUrls: string[];
  handoffMessage?: string;
  /** Quantas horas o agente fica calado depois de passar para humano. */
  pauseHours: number;
  maxRepliesPerHour: number;
}

export interface DmAgentAttachment {
  type: string;
  url: string;
}

export interface DmAgentRunInput {
  integrationId: string;
  organizationId: string;
  cfg: DmAgentConfig;
  igSenderId: string;
  igMessageId: string;
  messageText: string;
  attachments: DmAgentAttachment[];
}

export type DmAgentStatus =
  | 'sent'
  | 'shadow'
  | 'paused'
  | 'skipped'
  | 'error';

export interface DmAgentRunResult {
  status: DmAgentStatus;
  note?: string;
  /** Respostas que o agente montou (em shadow, nada foi enviado). */
  proposed?: string[];
  sent?: string[];
  /** true quando o agente decidiu chamar um humano. */
  handoff?: boolean;
  violations?: string[];
}
