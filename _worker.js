// ================= 诊断专用 Worker =================
// 目的：查看 Cloudflare 到底返回了什么字段

export default {
    async fetch(request, env) {
        // 允许跨域
        if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });

        const modelId = '@cf/qwen/qwen3-30b-a3b-fp8'; // 强制指定 Qwen3

        try {
            console.log(`Debug: Calling ${modelId}...`);

            // 调用 AI，强制开启流式
            const aiResponse = await env.AI.run(modelId, {
                messages: [{ role: 'user', content: 'hi' }], //以此固定简单的 Prompt 测试
                stream: true 
            });

            // 【关键步骤】
            // 不做任何解析，直接把 AI 返回的原始流转发给客户端
            // 这样我们在 curl 里就能看到它到底吐出了什么鬼东西
            return new Response(aiResponse, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Access-Control-Allow-Origin': '*',
                }
            });

        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
    }
};
