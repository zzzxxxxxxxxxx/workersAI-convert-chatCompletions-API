// ================= 配置区域 =================
let enable_stream = true; // 默认开启流式，强烈建议保持 true
let api_key = 'sk-xxxxxxxxxxxxxxxxx'; // 请替换为你的自定义 Key
let cf_account_array = [{ account_id: '你的AccountID', token: '你的Token' }]; // 仅在非流式模式下才需要，流式模式下走 Binding
// ===========================================

// 模型映射表
const TEXT_GENERATION_MODELS = {
    'qwen3-30b-a3b-thinking': '@cf/qwen/qwen3-30b-a3b-fp8', // 确保这个ID是正确的，有时CF会变
    'deepseek-r1-distill-qwen-32b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    'llama-3.3-70b-instruct-fp8-fast': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    'llama-3.1-8b-instruct': '@cf/meta/llama-3.1-8b-instruct',
};
const DEFAULT_MODEL = 'qwen3-30b-a3b-thinking';

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return handleCORS();

        // 环境变量覆盖
        if (env.API_KEY) api_key = env.API_KEY;
        if (env.STREAM) enable_stream = (env.STREAM === 'true' || env.STREAM === '1');

        if (!isAuthorized(request)) return new Response('Unauthorized', { status: 401 });

        const url = new URL(request.url);
        if (url.pathname.endsWith('/v1/models')) return handleModelsRequest();
        if (!url.pathname.endsWith('/v1/chat/completions')) return new Response('Not Found', { status: 404 });

        return handleChatCompletions(request, env);
    }
};

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

function isAuthorized(request) {
    const authHeader = request.headers.get('Authorization');
    return authHeader && authHeader.startsWith('Bearer ') && authHeader.split(' ')[1] === api_key;
}

function handleModelsRequest() {
    const models = Object.keys(TEXT_GENERATION_MODELS).map((id) => ({ id, object: 'model' }));
    return new Response(JSON.stringify({ data: models, object: 'list' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
}

async function handleChatCompletions(request, env) {
    try {
        const { messages, model: requestedModel, stream } = await request.json();
        
        // 如果客户端请求中明确指定了 stream，优先使用客户端的设置
        const isStream = stream !== undefined ? stream : enable_stream;

        // 模型选择逻辑
        const modelId = TEXT_GENERATION_MODELS[requestedModel] || TEXT_GENERATION_MODELS[DEFAULT_MODEL] || Object.values(TEXT_GENERATION_MODELS)[0];

        if (isStream) {
            return await handleStreamResponse(env, modelId, messages);
        } else {
            return await handleNonStreamResponse(env, modelId, messages); // 注意：这里我也改成了优先用 env 调用
        }
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// 核心修复：更健壮的流式处理
async function handleStreamResponse(env, model, messages) {
    try {
        // 使用 Workers AI Binding 调用
        const responseStream = await env.AI.run(model, {
            messages: messages,
            stream: true,
        });

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // 异步处理流
        (async () => {
            const reader = responseStream.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // 保留最后一个可能不完整的行

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine.startsWith('data: ')) continue;
                        if (trimmedLine === 'data: [DONE]') continue;

                        try {
                            const dataStr = trimmedLine.slice(6); // 去掉 'data: '
                            const json = JSON.parse(dataStr);
                            
                            // Cloudflare AI 返回的字段通常是 'response'
                            const content = json.response; 

                            if (content) {
                                const chunk = JSON.stringify({
                                    id: `chatcmpl-${Date.now()}`,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: model,
                                    choices: [{ delta: { content: content }, index: 0, finish_reason: null }]
                                });
                                await writer.write(encoder.encode(`data: ${chunk}\n\n`));
                            }
                        } catch (e) {
                            // 忽略解析错误的行
                        }
                    }
                }
            } catch (err) {
                console.error('Stream error:', err);
                await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
            } finally {
                await writer.write(encoder.encode('data: [DONE]\n\n'));
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

    } catch (error) {
        return new Response(JSON.stringify({ error: 'AI Error: ' + error.message }), { status: 500 });
    }
}

// 非流式处理（为了兼容性，也通过 Binding 调用，不走 HTTP API 了）
async function handleNonStreamResponse(env, model, messages) {
    const response = await env.AI.run(model, { messages });
    const content = response.response;

    const json = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ message: { role: 'assistant', content: content }, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    return new Response(JSON.stringify(json), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
