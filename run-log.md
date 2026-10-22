2026-10-22T19:29:02.188Z model reply 26933 chars, stop end_turn
2026-10-22T19:29:03.419Z RUN FAILED: SyntaxError: Unexpected token 'A', "A server e"... is not valid JSON
    at JSON.parse (<anonymous>)
    at parseJSONFromBytes (node:internal/deps/undici/undici:5880:19)
    at successSteps (node:internal/deps/undici/undici:5861:27)
    at fullyReadBody (node:internal/deps/undici/undici:4753:9)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async consumeBody (node:internal/deps/undici/undici:5870:7)
    at async turn (file:///home/runner/work/purple-agent/purple-agent/agent.mjs:242:14)
    at async file:///home/runner/work/purple-agent/purple-agent/agent.mjs:269:16
