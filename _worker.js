// ================= 极简调试版 Worker =================

const MODEL_MAP = {
    'qwen3-30b-a3b-thinking': '@cf/qwen/qwen3-30b-a3b-fp8',
    'llama-3.1-8b-instruct': '@cf/meta/llama-3.1-8b-instruct',
    // 你可以加别的，但在调试阶段这两个够了
};

const DEFAULT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

export default {
    async fetch(request, env) {
        // 1. 基础处理
        if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
        
        // 2. 简单鉴权 (如果有 API_KEY 环境变量则检查)
        if (env.API_KEY) {
            const auth = request.headers.get('Authorization');
            if (!auth || auth.split(' ')[1] !== env.API_KEY) {
                return new Response('Unauthorized', { status: 401 });
            }
        }

        try {
            // 3. 解析请求
            const body = await request.json();
            const userModel = body.model;
            // 找到对应的真实模型ID，找不到就用默认的
            const realModel = MODEL_MAP[userModel] || DEFAULT_MODEL;

            console.log(`Debug: Requesting model ${realModel}`);

            // 4. 【关键】直接调用 AI，不做任何解析
            // 这里的 response 本身就是一个 ReadableStream (或者包含 body 的 Response)
            const aiResponse = await env.AI.run(realModel, {
                messages: body.messages,
                stream: true // 强制开启流式
            });

            // 5. 直接把 Cloudflare 的原始数据转发给你
            // 这样我们就能在 curl 里看到它到底返回了什么鬼东西
            return new Response(aiResponse, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache'
                }
            });

        } catch (err) {
            return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500 });
        }
    }
};
