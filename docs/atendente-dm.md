# Atendente de DM (gatilho `dm_direct`)

Responde mensagens diretas do Instagram com IA, usando só a **ficha** do restaurante.
Convive com as automações de comentário e de story: o gatilho `dm_direct` só reage a DM comum (sem story).

## Como funciona
1. A Meta envia a DM ao webhook (`/public/ig-webhook`). Sem story, o controlador chama `FlowsService.handleIncomingDirectMessage`.
2. Se a conta tem um flow `dm_direct` ativo (se houver mais de um, só o mais antigo responde), inicia o workflow `flowExecutionWorkflow`.
3. A atividade `runDmAgent` (orquestrador) chama `DmAgentService.run`: pausa/limite → nome da pessoa → histórico → IA (com foto, se houver) → **validação** (preço, link, telefone fora da ficha; "pedido/reserva confirmada") → envia.
4. Se uma pessoa da loja responde pelo app, o eco da mensagem pausa o agente naquela conversa (`pauseHours`).

## Segurança (padrões)
- Modo **`shadow`** por padrão: registra o que responderia no histórico de execuções e **não envia**. Só `"mode": "auto"` envia.
- Nunca tira pedido nem confirma reserva; preço, link e telefone só os da ficha (senão chama a equipa).
- Limite de respostas por hora por cliente (`maxRepliesPerHour`, padrão 30), dedupe por mensagem, pausa por conversa.
- Redis indisponível: o agente fica quieto.
- Janela de 24 h da Meta: só responde a quem escreveu agora.

## Criar o flow (sem tela por enquanto)
`POST /public/v1/flows` (chave de API do perfil) com `triggerType: "dm_direct"`, `postMode: "all"` e `agent`:

```json
{
  "name": "Atendente de DM",
  "integrationId": "<id do canal Instagram>",
  "triggerType": "dm_direct",
  "postMode": "all",
  "agent": {
    "mode": "shadow",
    "businessName": "The Best Burger Nazaré",
    "assistantName": "Best",
    "timezone": "Europe/Lisbon",
    "hours": {
      "mon": [["18:00", "01:00"]], "tue": [["18:00", "01:00"]], "wed": [["18:00", "01:00"]], "thu": [["18:00", "01:00"]],
      "fri": [["12:00", "01:00"]], "sat": [["12:00", "01:00"]], "sun": [["12:00", "01:00"]]
    },
    "deliveryUrl": "https://glovoapp.com/pt/pt/nazare/stores/hamburgueria-belaburguer-nzr",
    "persona": "Tom simpático e direto, português de Portugal, tratar por tu.",
    "knowledge": "<ficha do restaurante em texto/markdown>",
    "pauseHours": 12,
    "maxRepliesPerHour": 30
  }
}
```

## Requisitos na Meta
- Conta Instagram profissional conectada ao Autopublic, com token de messaging (Credenciais) e assinatura do webhook da conta.
- Campos do webhook assinados: `messages` e, para o agente se calar quando a loja responde, **`message_echoes`**.

## Testes
`pnpm exec jest --selectProjects nestjs-libraries --testPathPattern dm-agent`
