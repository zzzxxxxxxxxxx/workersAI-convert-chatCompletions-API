// ================= 配置区域 =================
let enable_stream = true; // 强制开启流式
let api_key = 'sk-123456'; // 【注意】这里填你的 Key，或者在 Worker 环境变量里填 API_KEY
// ===========================================

// 模型映射
const TEXT_GENERATION_MODELS = {
    'qwen3-30b-a3b-thinking': '@cf/qwen/qwen3-30b-a3b-fp8',
    'deepseek-r1-distill-qwen-32b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    'llama-3.3-70b-instruct-fp8-fast': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};
const DEFAULT_MODEL = 'qwen3-30b-a3b-thinking';

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return handleCORS();

        // 1. 鉴权
        if (env.API_KEY) api_key = env.API_KEY;
        if (!isAuthorized(request)) return new Response('Unauthorized', { status: 401 });

        // 2. 路由
        const url = new URL(request.url);
        if (url.pathname.endsWith('/v1/models')) return handleModelsRequest();
        
        // 3. 处理对话
        return handleChatCompletions(request, env);
    }
};

// CORS 允许跨域
function handleCORS() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
    });
}

// 鉴权检查
function isAuthorized(request) {
    const authHeader = request.headers.get('Authorization');
    return authHeader && authHeader.startsWith('Bearer ') && authHeader.split(' ')[1] === api_key;
}

// 返回模型列表
function handleModelsRequest() {
    const models = Object.keys(TEXT_GENERATION_MODELS).map((id) => ({ id, object: 'model' }));
    return new Response(JSON.stringify({ data: models, object: 'list' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
}

// 核心处理函数
async function handleChatCompletions(request, env) {
    try {
        const body = await request.json();
        const messages = body.messages;
        const requestedModel = body.model;

        // 获取真实模型ID
        const modelId = TEXT_GENERATION_MODELS[requestedModel] || TEXT_GENERATION_MODELS[DEFAULT_MODEL];

        console.log(`[请求] 模型: ${modelId}, 模式: Stream`);

        // 调用 Cloudflare AI (必须绑定 Workers AI 为变量名 AI)
        const eventStream = await env.AI.run(modelId, {
            messages: messages,
            stream: true,
        });

        // 创建转换流，将 Cloudflare 格式转换为 OpenAI 格式
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        // 异步处理流数据
        (async () => {
            const reader = eventStream.getReader();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        await writer.write(encoder.encode('data: [DONE]\n\n'));
                        break;
                    }

                    // 1. 解码当前数据包
                    buffer += decoder.decode(value, { stream: true });

                    // 2. 按行分割（处理粘包）
                    const lines = buffer.split('\n');
                    // 3. 最后一个可能不完整，放回缓冲区等待下一次
                    buffer = lines.pop(); 

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data: ')) continue;
                        if (trimmed === 'data: [DONE]') continue;

                        try {
                            // 4. 解析 JSON
                            const jsonStr = trimmed.slice(6); // 去掉 "data: "
                            const json = JSON.parse(jsonStr);
                            const content = json.response; // Cloudflare 返回的字段

                            // 5. 封装成 OpenAI 格式
                            if (content) {
                                const openaiChunk = JSON.stringify({
                                    id: 'chatcmpl-' + Date.now(),
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: requestedModel,
                                    choices: [{
                                        index: 0,
                                        delta: { content: content },
                                        finish_reason: null
                                    }]
                                });
                                await writer.write(encoder.encode(`data: ${openaiChunk}\n\n`));
                            }
                        } catch (e) {
                            // 忽略解析失败的行
                        }
                    }
                }
            } catch (err) {
                console.error('Stream processing error:', err);
                const errorChunk = JSON.stringify({ error: err.message });
                await writer.write(encoder.encode(`data: ${errorChunk}\n\n`));
            } finally {
                writer.close();
            }
        })();

        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
