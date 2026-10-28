import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { echoKey } from './dm-agent.logic';

// Estado efemero do atendente de DM no Redis: pausa por conversa, historico
// curto, limite por hora, anti-duplicidade e reconhecimento do eco das
// proprias respostas. Politica de falha: na duvida o agente FICA QUIETO
// (nunca responde sem controle de pausa/limite).

export interface DmHistoryEntry {
  /** u = cliente, a = agente, h = pessoa da loja (resposta humana) */
  r: 'u' | 'a' | 'h';
  t: string;
  ts: number;
}

export interface DmProfile {
  name?: string;
  username?: string;
}

const HISTORY_MAX = 20;
const HISTORY_TTL_S = 7 * 24 * 3600;
const PROFILE_TTL_S = 7 * 24 * 3600;
const ECHO_TTL_S = 180;
const MSG_CLAIM_TTL_S = 3600;

const key = (...parts: string[]): string => ['dmagent', ...parts].join(':');

export const DmAgentState = {
  async isPaused(integrationId: string, igsid: string): Promise<boolean> {
    try {
      return !!(await ioRedis.get(key('pause', integrationId, igsid)));
    } catch {
      return true;
    }
  },

  async pause(integrationId: string, igsid: string, hours: number): Promise<void> {
    try {
      await ioRedis.set(
        key('pause', integrationId, igsid),
        String(Date.now()),
        'EX',
        Math.max(60, Math.round(hours * 3600))
      );
    } catch {
      // sem Redis nao ha como pausar; o proximo isPaused ja falha para o lado seguro
    }
  },

  /** true = esta execucao "ganhou" a mensagem; false = ja foi tratada (ou Redis indisponivel). */
  async claimMessage(igMessageId: string): Promise<boolean> {
    try {
      const r = await ioRedis.set(key('msg', igMessageId), '1', 'EX', MSG_CLAIM_TTL_S, 'NX');
      return r === 'OK';
    } catch {
      return false;
    }
  },

  async releaseMessage(igMessageId: string): Promise<void> {
    try {
      await ioRedis.del(key('msg', igMessageId));
    } catch {
      // ignora
    }
  },

  async underRateLimit(
    integrationId: string,
    igsid: string,
    max: number
  ): Promise<boolean> {
    try {
      const k = key('rate', integrationId, igsid);
      const n = await ioRedis.incr(k);
      if (n === 1) await ioRedis.expire(k, 3600);
      return n <= max;
    } catch {
      return false;
    }
  },

  /** Guarda a impressao digital do texto que o agente vai enviar, para reconhecer o eco depois. */
  async rememberSent(integrationId: string, igsid: string, text: string): Promise<void> {
    try {
      await ioRedis.set(key('sent', integrationId, igsid, echoKey(text)), '1', 'EX', ECHO_TTL_S);
    } catch {
      // ignora
    }
  },

  /** true = o eco e de uma resposta do proprio agente. Em caso de erro devolve false (=> pausa, lado seguro). */
  async isOwnEcho(integrationId: string, igsid: string, text: string): Promise<boolean> {
    try {
      return !!(await ioRedis.get(key('sent', integrationId, igsid, echoKey(text))));
    } catch {
      return false;
    }
  },

  async pushHistory(
    integrationId: string,
    igsid: string,
    entry: DmHistoryEntry
  ): Promise<void> {
    try {
      const k = key('hist', integrationId, igsid);
      await ioRedis.rpush(k, JSON.stringify({ ...entry, t: entry.t.slice(0, 600) }));
      await ioRedis.ltrim(k, -HISTORY_MAX, -1);
      await ioRedis.expire(k, HISTORY_TTL_S);
    } catch {
      // ignora
    }
  },

  async getHistory(
    integrationId: string,
    igsid: string,
    n = 16
  ): Promise<DmHistoryEntry[]> {
    try {
      const raw = await ioRedis.lrange(key('hist', integrationId, igsid), -n, -1);
      const out: DmHistoryEntry[] = [];
      for (const line of raw) {
        try {
          const o = JSON.parse(line);
          if (o && (o.r === 'u' || o.r === 'a' || o.r === 'h') && typeof o.t === 'string') {
            out.push({ r: o.r, t: o.t, ts: Number(o.ts) || 0 });
          }
        } catch {
          // linha invalida: ignora
        }
      }
      return out;
    } catch {
      return [];
    }
  },

  /** Marca a mensagem mais recente da conversa (para so a ultima de uma sequencia responder). */
  async setLatest(integrationId: string, igsid: string, igMessageId: string): Promise<void> {
    try {
      await ioRedis.set(key('latest', integrationId, igsid), igMessageId, 'EX', 300);
    } catch {
      // ignora
    }
  },

  async getLatest(integrationId: string, igsid: string): Promise<string | null> {
    try {
      return (await ioRedis.get(key('latest', integrationId, igsid))) || null;
    } catch {
      return null;
    }
  },

  async getProfile(integrationId: string, igsid: string): Promise<DmProfile | null> {
    try {
      const raw = await ioRedis.get(key('prof', integrationId, igsid));
      return raw ? (JSON.parse(raw) as DmProfile) : null;
    } catch {
      return null;
    }
  },

  async setProfile(integrationId: string, igsid: string, profile: DmProfile): Promise<void> {
    try {
      await ioRedis.set(
        key('prof', integrationId, igsid),
        JSON.stringify(profile),
        'EX',
        PROFILE_TTL_S
      );
    } catch {
      // ignora
    }
  },
};
