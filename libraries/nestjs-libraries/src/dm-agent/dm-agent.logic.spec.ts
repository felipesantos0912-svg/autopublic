import {
  buildPriceIndex,
  buildSystemPrompt,
  defaultHandoffMessage,
  describeNow,
  echoKey,
  openStatus,
  parseAgentConfig,
  parseModelOutput,
  pickFirstName,
  validateMessages,
} from './dm-agent.logic';

const hours = {
  mon: [['18:00', '01:00']],
  tue: [['18:00', '01:00']],
  wed: [['18:00', '01:00']],
  thu: [['18:00', '01:00']],
  fri: [['12:00', '01:00']],
  sat: [['12:00', '01:00']],
  sun: [['12:00', '01:00']],
} as any;
const TZ = 'Europe/Lisbon';
const at = (iso: string) => new Date(iso);

const GLOVO =
  'https://glovoapp.com/pt/pt/nazare/stores/hamburgueria-belaburguer-nzr';
const knowledge = [
  'Big Burger 10,90 € (160 g). X-Tudo 16,90 €; menu 16,92 € (de 19,90). Água 1,50 €. Saco 0,10 €.',
  `Glovo: ${GLOVO}`,
  'Mapa: https://maps.app.goo.gl/L3a1ZWLa8ChPrEc58',
  'WhatsApp: +351 963 678 639',
].join('\n');
const cfgRaw = JSON.stringify({
  triggerType: 'dm_direct',
  agent: {
    businessName: 'The Best Burger Nazaré',
    timezone: TZ,
    hours,
    knowledge,
    deliveryUrl: GLOVO,
  },
});
const cfg = parseAgentConfig(cfgRaw)!;

describe('openStatus (horário que atravessa a meia-noite)', () => {
  // 2026-10-28 é quarta-feira; Portugal está em horário de inverno (UTC+0)
  it('quarta 19:00 está aberto e fecha às 01:00', () => {
    const s = openStatus(hours, TZ, at('2026-10-28T19:00:00Z'));
    expect(s.known).toBe(true);
    expect(s.open).toBe(true);
    expect(s.closesAt).toBe('01:00');
  });
  it('quarta 00:30 (noite de terça) está aberto', () => {
    expect(openStatus(hours, TZ, at('2026-10-28T00:30:00Z')).open).toBe(true);
  });
  it('quarta 10:00 fechado, abre hoje às 18:00', () => {
    const s = openStatus(hours, TZ, at('2026-10-28T10:00:00Z'));
    expect(s.open).toBe(false);
    expect(s.nextOpen).toEqual({ dayOffset: 0, dayKey: 'wed', hhmm: '18:00' });
  });
  it('sábado 11:00 fechado, abre hoje às 12:00', () => {
    const s = openStatus(hours, TZ, at('2026-10-31T11:00:00Z'));
    expect(s.open).toBe(false);
    expect(s.nextOpen?.hhmm).toBe('12:00');
  });
  it('domingo 23:00 e segunda 00:30 abertos; segunda 02:00 fechado', () => {
    expect(openStatus(hours, TZ, at('2026-11-01T23:00:00Z')).open).toBe(true);
    expect(openStatus(hours, TZ, at('2026-11-02T00:30:00Z')).open).toBe(true);
    expect(openStatus(hours, TZ, at('2026-11-02T02:00:00Z')).open).toBe(false);
  });
  it('sem horário não sabe; fuso inválido não quebra', () => {
    expect(openStatus(undefined, TZ, at('2026-10-28T19:00:00Z')).known).toBe(false);
    expect(() =>
      openStatus(hours, 'Nao/Existe', at('2026-10-28T19:00:00Z'))
    ).not.toThrow();
  });
});

describe('parseAgentConfig', () => {
  it('padrão seguro: modo shadow, pausa 12 h, 30 respostas/h', () => {
    expect(cfg.mode).toBe('shadow');
    expect(cfg.pauseHours).toBe(12);
    expect(cfg.maxRepliesPerHour).toBe(30);
    expect(cfg.maxTotalPerHour).toBe(300);
    expect(cfg.debounceSeconds).toBe(3);
  });
  it('limites fora da faixa são ajustados', () => {
    const c = parseAgentConfig(
      JSON.stringify({
        agent: { knowledge: 'x', pauseHours: 999, maxRepliesPerHour: 0, debounceSeconds: 99, maxTotalPerHour: 1 },
      })
    )!;
    expect(c.pauseHours).toBe(72);
    expect(c.maxRepliesPerHour).toBe(1);
    expect(c.debounceSeconds).toBe(15);
    expect(c.maxTotalPerHour).toBe(10);
  });
  it('auto só quando pedido; config inválida vira null', () => {
    const c = parseAgentConfig(
      JSON.stringify({ agent: { mode: 'auto', knowledge: 'x', businessName: 'A' } })
    );
    expect(c?.mode).toBe('auto');
    expect(parseAgentConfig('{nao e json')).toBeNull();
    expect(
      parseAgentConfig(JSON.stringify({ agent: { enabled: false, knowledge: 'x' } }))
    ).toBeNull();
    expect(parseAgentConfig(JSON.stringify({ agent: { knowledge: '  ' } }))).toBeNull();
    expect(parseAgentConfig(JSON.stringify({ triggerType: 'story_reply' }))).toBeNull();
  });
});

describe('parseModelOutput', () => {
  it('JSON limpo, com cerca de código, quebrado e texto puro', () => {
    const a = parseModelOutput(
      '{"messages":["Olá! 🍔","Queres o link?"],"handoff":false,"handoff_reason":""}'
    );
    expect(a.parsed).toBe(true);
    expect(a.messages).toEqual(['Olá! 🍔', 'Queres o link?']);
    const b = parseModelOutput(
      '```json\n{"messages":["Ok"],"handoff":true,"handoff_reason":"alergia"}\n```'
    );
    expect(b.handoff).toBe(true);
    expect(b.handoffReason).toBe('alergia');
    const c = parseModelOutput('{"messages":["abc"');
    expect(c.handoff).toBe(true);
    expect(c.messages).toEqual([]);
    const d = parseModelOutput('Olá, tudo bem?');
    expect(d.parsed).toBe(false);
    expect(d.messages).toEqual(['Olá, tudo bem?']);
    expect(parseModelOutput('{"messages":["1","2","3","4","5","6"]}').messages).toHaveLength(4);
  });
});

describe('validateMessages (anti-invenção)', () => {
  it('preço da ficha passa; preço inventado não', () => {
    expect(validateMessages(['O Big Burger sai a 10,90 € na Glovo.'], cfg).ok).toBe(true);
    expect(validateMessages(['O X-Tudo sai a 16.90€ na Glovo.'], cfg).ok).toBe(true);
    expect(validateMessages(['Custa 10,90 euros'], cfg).ok).toBe(true);
    const bad = validateMessages(['O Big Burger custa 12,00 €.'], cfg);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.startsWith('preco_fora_da_ficha'))).toBe(true);
  });
  it('links: só os da ficha', () => {
    expect(validateMessages([`Pede aqui: ${GLOVO}.`], cfg).ok).toBe(true);
    expect(
      validateMessages(['Como chegar: https://maps.app.goo.gl/L3a1ZWLa8ChPrEc58?g_st=iw'], cfg).ok
    ).toBe(true);
    expect(validateMessages(['Vê em https://exemplo.com/cardapio'], cfg).ok).toBe(false);
  });
  it('telefone inventado e confirmação de pedido/reserva', () => {
    expect(validateMessages(['Liga para +351 963 678 639'], cfg).ok).toBe(true);
    expect(validateMessages(['Liga para 912 345 678'], cfg).ok).toBe(false);
    expect(validateMessages(['O teu pedido foi confirmado!'], cfg).ok).toBe(false);
    expect(validateMessages(['Reserva confirmada para sábado'], cfg).ok).toBe(false);
    expect(validateMessages(['Já anotei o teu pedido'], cfg).ok).toBe(false);
    expect(validateMessages(['Olá! Estamos abertos até à 01h 🍔'], cfg).ok).toBe(true);
  });
  it('quantidade de mensagens e mensagem vazia', () => {
    expect(validateMessages([], cfg).ok).toBe(false);
    expect(validateMessages(['a', 'b', 'c', 'd', 'e'], cfg).ok).toBe(false);
    expect(validateMessages(['  '], cfg).ok).toBe(false);
  });
});

describe('eco, nomes, prompt', () => {
  it('mesma mensagem com espaços/caixa diferentes gera a mesma chave', () => {
    expect(echoKey('Olá!  Tudo bem?')).toBe(echoKey('olá! tudo   bem?'));
    expect(echoKey('a')).not.toBe(echoKey('b'));
  });
  it('primeiro nome só se parecer nome de pessoa', () => {
    expect(pickFirstName('Felipe Luiz')).toBe('Felipe');
    expect(pickFirstName('ANA')).toBe('Ana');
    expect(pickFirstName('María José')).toBe('María');
    expect(pickFirstName('x_y.99')).toBeUndefined();
    expect(pickFirstName('J')).toBeUndefined();
    expect(pickFirstName(null)).toBeUndefined();
  });
  it('descreve o momento atual e a mensagem de transferência', () => {
    expect(describeNow(cfg, at('2026-10-28T10:00:00Z'))).toMatch(/FECHADO.*18:00/);
    expect(describeNow(cfg, at('2026-10-28T19:00:00Z'))).toMatch(/ABERTO/);
    expect(defaultHandoffMessage(cfg, at('2026-10-28T10:00:00Z'))).toMatch(
      /abrimos hoje às 18:00/
    );
    expect(defaultHandoffMessage(cfg, at('2026-10-28T19:00:00Z'))).not.toMatch(/abrimos/);
  });
  it('prompt traz as regras, a ficha, o link e o contexto', () => {
    const p = buildSystemPrompt(cfg, 'Agora são 19:00 de quarta-feira.', 'Marcus');
    expect(p).toMatch(/NÃO tires pedidos/);
    expect(p).toMatch(/glovoapp\.com/);
    expect(p).toMatch(/Marcus/);
    expect(buildSystemPrompt(cfg, 'x', undefined)).toMatch(/Nome do cliente desconhecido/);
  });
});

describe('preço de outro item e promoções inventadas', () => {
  const k2 =
    'Menus: X-Tudo 16,92 € (de 19,90 €); Big Burger 16,90 €. Só o item: X-Tudo 16,90 €; Big Burger 10,90 €; Cheese Bacon 10,40 €; Durum Kebab 9,00 € (em tortilha). Extras: bacon (2 fatias) 2,00 €.';
  const cfg2 = parseAgentConfig(
    JSON.stringify({ agent: { knowledge: k2, businessName: 'X' } })
  )!;

  it('índice de preços por item', () => {
    const idx = buildPriceIndex(k2);
    expect([...idx.get('big burger')!].sort()).toEqual(['10.90', '16.90']);
    expect([...idx.get('x-tudo')!].sort()).toEqual(['16.90', '16.92', '19.90']);
    expect(idx.get('durum kebab')!.has('9.00')).toBe(true);
    expect(idx.get('bacon')!.has('2.00')).toBe(true);
  });
  it('preço que existe na ficha mas é de outro item é barrado', () => {
    const r = validateMessages(['O Big Burger custa 9,00 €.'], cfg2);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.startsWith('preco_de_outro_item'))).toBe(true);
    expect(validateMessages(['O Cheese Bacon sai a 10,90 €.'], cfg2).ok).toBe(false);
  });
  it('preços certos passam, inclusive vários itens e preço antigo', () => {
    expect(validateMessages(['O Big Burger sai a 10,90 € e o Cheese Bacon a 10,40 €.'], cfg2).ok).toBe(true);
    expect(validateMessages(['O Big Burger sai a 10,90 € (ou 16,90 € no menu).'], cfg2).ok).toBe(true);
    expect(validateMessages(['O menu X-Tudo está a 16,92 € (em vez de 19,90 €).'], cfg2).ok).toBe(true);
    expect(validateMessages(['Podes juntar bacon por 2,00 €.'], cfg2).ok).toBe(true);
    expect(validateMessages(['O Durum Kebab é 9,00 €.'], cfg2).ok).toBe(true);
  });
  it('desconto, promoção, grátis e percentagem inventados são barrados', () => {
    expect(validateMessages(['Hoje tens 20% de desconto 🍔'], cfg).ok).toBe(false);
    expect(validateMessages(['Temos uma promoção especial!'], cfg).ok).toBe(false);
    expect(validateMessages(['A entrega é grátis hoje.'], cfg).ok).toBe(false);
    expect(validateMessages(['Muito obrigado pela preferência! 🍔'], cfg).ok).toBe(true);
  });
  it('se a ficha cita a promoção, deixa de ser invenção; "não confirmado" não conta', () => {
    const withPromo = parseAgentConfig(
      JSON.stringify({
        agent: { businessName: 'X', knowledge: 'Promoção de terça: Big Burger 9,90 €. Desconto de 10% para estudantes.' },
      })
    )!;
    expect(validateMessages(['Na terça há promoção: Big Burger a 9,90 €.'], withPromo).ok).toBe(true);
    expect(validateMessages(['Estudantes têm 10% de desconto.'], withPromo).ok).toBe(true);
    expect(validateMessages(['Estudantes têm 50% de desconto.'], withPromo).ok).toBe(false);
    const naoConf = parseAgentConfig(
      JSON.stringify({
        agent: { businessName: 'X', knowledge: 'Big Burger 10,90 €.\nNÃO CONFIRMADO (chama a equipa): descontos; reservas.' },
      })
    )!;
    expect(validateMessages(['Hoje há desconto no Big Burger!'], naoConf).ok).toBe(false);
    expect(validateMessages(['O Big Burger sai a 10,90 €.'], naoConf).ok).toBe(true);
  });
});
