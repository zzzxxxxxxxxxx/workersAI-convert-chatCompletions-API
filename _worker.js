// ================= 配置区域 =================
let enable_stream = true; 
let api_key = 'sk-123456'; // 【必填】你的 Key，建议在环境变量设置 API_KEY
// ===========================================

const TEXT_GENERATION_MODELS = {
    'qwen3-30b-a3b-thinking': '@cf/qwen/qwen3-30b-a3b-fp8',
    'deepseek-r1-distill-qwen-32b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    'llama-3.1-8b-instruct': '@cf/meta/llama-3.1-8b-instruct',
    'llama-3.3-70b-instruct-fp8-fast': '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
};
const DEFAULT_MODEL = 'qwen3-30b-a3b-thinking';

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return handleCORS();
        if (env.API_KEY) api_key = env.API_KEY;
        if (!isAuthorized(request)) return new Response('Unauthorized', { status: 401 });

        const url = new URL(request.url);
        if (url.pathname.endsWith('/v1/models')) return handleModelsRequest();
        
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
        const body = await request.json();
        const messages = body.messages;
        const requestedModel = body.model;
        const modelId = TEXT_GENERATION_MODELS[requestedModel] || TEXT_GENERATION_MODELS[DEFAULT_MODEL] || Object.values(TEXT_GENERATION_MODELS)[0];

        // 调用 Cloudflare AI
        const eventStream = await env.AI.run(modelId, {
            messages: messages,
            stream: true,
        });

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        (async () => {
            const reader = eventStream.getReader();
            let buffer = '';
            
            // 状态机：用于给思考过程加标签
            let isThinking = false; 
            let hasAddedStartTag = false;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        // 如果结束时还在思考，补一个闭合标签
                        if (isThinking) {
                            await sendChunk(writer, encoder, requestedModel, "\n</think>\n");
                        }
                        await writer.write(encoder.encode('data: [DONE]\n\n'));
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); 

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data: ')) continue;
                        if (trimmed === 'data: [DONE]') continue;

                        try {
                            const jsonStr = trimmed.slice(6);
                            const json = JSON.parse(jsonStr);
                            
                            // === 核心逻辑：智能字段提取 ===
                            
                            let content = null;
                            let isReasoning = false;

                            // 1. 处理新版 Qwen/DeepSeek (Native OpenAI Format)
                            if (json.choices && json.choices[0] && json.choices[0].delta) {
                                const delta = json.choices[0].delta;
                                
                                // 提取思考内容
                                if (delta.reasoning_content) {
                                    content = delta.reasoning_content;
                                    isReasoning = true;
                                } 
                                // 提取正文内容
                                else if (delta.content) {
                                    content = delta.content;
                                    isReasoning = false;
                                }
                            }
                            // 2. 处理旧版 Llama (Legacy Cloudflare Format)
                            else if (json.response) {
                                content = json.response;
                                isReasoning = false; // 旧版通常没有分离的思考字段
                            }

                            // === 状态机处理：自动加 <think> 标签 ===
                            if (content) {
                                if (isReasoning && !isThinking) {
                                    // 开始思考：发送 <think>
                                    isThinking = true;
                                    if (!hasAddedStartTag) {
                                        await sendChunk(writer, encoder, requestedModel, "<think>\n");
                                        hasAddedStartTag = true;
                                    }
                                } else if (!isReasoning && isThinking) {
                                    // 思考结束：发送 </think>
                                    isThinking = false;
                                    await sendChunk(writer, encoder, requestedModel, "\n</think>\n");
                                }

                                // 发送实际内容
                                await sendChunk(writer, encoder, requestedModel, content);
                            }

                        } catch (e) { }
                    }
                }
            } catch (err) {
                console.error('Stream Error:', err);
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

// 辅助函数：发送 OpenAI 格式的 Chunk
async function sendChunk(writer, encoder, model, content) {
    const chunk = JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            delta: { content: content }, // 无论是不是思考，都塞进 content 让客户端显示
            finish_reason: null
        }]
    });
    await writer.write(encoder.encode(`data: ${chunk}\n\n`));
}
