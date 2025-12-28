// ================= 配置区域 =================
let enable_stream = true; // 强制开启流式
let api_key = 'sk-123456'; // 【必填】请替换为你的自定义 Key，或者在 Worker 环境变量里填 API_KEY
// ===========================================

// 模型映射表 (包含你想要的 Qwen Thinking 和其他常用模型)
const TEXT_GENERATION_MODELS = {
    // 你的目标模型
    'qwen3-30b-a3b-thinking': '@cf/qwen/qwen3-30b-a3b-fp8',
    'deepseek-r1-distill-qwen-32b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    
    // 备用稳定模型
    'llama-3.1-8b-instruct': '@cf/meta/llama-3.1-8b-instruct',
    'llama-3.3-70b-instruct-fp8-fast': '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
};

const DEFAULT_MODEL = 'qwen3-30b-a3b-thinking';

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return handleCORS();

        // 1. 鉴权：优先读取环境变量
        if (env.API_KEY) api_key = env.API_KEY;
        if (!isAuthorized(request)) return new Response('Unauthorized', { status: 401 });

        // 2. 路由检查
        const url = new URL(request.url);
        if (url.pathname.endsWith('/v1/models')) return handleModelsRequest();
        
        // 3. 处理对话请求
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

// 鉴权逻辑
function isAuthorized(request) {
    const authHeader = request.headers.get('Authorization');
    return authHeader && authHeader.startsWith('Bearer ') && authHeader.split(' ')[1] === api_key;
}

// 返回模型列表（骗客户端用）
function handleModelsRequest() {
    const models = Object.keys(TEXT_GENERATION_MODELS).map((id) => ({ id, object: 'model' }));
    return new Response(JSON.stringify({ data: models, object: 'list' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
}

// 核心对话处理
async function handleChatCompletions(request, env) {
    try {
        const body = await request.json();
        const messages = body.messages;
        const requestedModel = body.model;

        // 查找真实模型 ID
        const modelId = TEXT_GENERATION_MODELS[requestedModel] || TEXT_GENERATION_MODELS[DEFAULT_MODEL] || Object.values(TEXT_GENERATION_MODELS)[0];

        console.log(`Forwarding to: ${modelId}`);

        // 调用 Cloudflare AI
        const eventStream = await env.AI.run(modelId, {
            messages: messages,
            stream: true,
        });

        // 创建流转换器：将 Cloudflare 格式 -> OpenAI 格式
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        // 异步处理流
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

                    // 解码并拼接到缓冲区
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // 保留最后一行（因为可能是不完整的）

                    for (const line of lines) {
                        const trimmed = line.trim();
                        // 你的日志显示 Cloudflare 返回的是 "data: {...}"
                        if (!trimmed.startsWith('data: ')) continue;
                        if (trimmed === 'data: [DONE]') continue;

                        try {
                            const jsonStr = trimmed.slice(6); // 去掉 "data: "
                            const json = JSON.parse(jsonStr);
                            
                            // 你的日志显示字段名是 "response"
                            const content = json.response; 

                            // 只有当 content 有值时才发送（忽略最后的 null/usage）
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
                            // 忽略 JSON 解析错误（防止偶尔的粘包导致崩溃）
                        }
                    }
                }
            } catch (err) {
                console.error('Stream Error:', err);
                const errChunk = JSON.stringify({ error: err.message });
                await writer.write(encoder.encode(`data: ${errChunk}\n\n`));
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
        return new Response(JSON.stringify({ error: 'Worker Error: ' + e.message }), { status: 500 });
    }
}
