/**
 * AI 推荐引擎 - OpenRouter 兼容版
 * 支持所有 OpenAI 兼容格式的 API（OpenRouter / 通义千问 / DeepSeek 等）
 * 
 * 环境变量：
 *   AI_ENABLED     - 是否启用 (true/false)
 *   AI_API_URL     - API 地址 (如 https://openrouter.ai/api/v1)
 *   AI_API_KEY     - API Key
 *   AI_MODEL       - 模型名称 (如 meta-llama/llama-3.3-70b-instruct:free)
 *   AI_MAX_TOKENS  - 最大 token (默认 1024)
 *   AI_TEMPERATURE - 温度参数 (默认 0.7)
 */

const axios = require('axios');

const config = {
  enabled: process.env.AI_ENABLED === 'true',
  apiUrl: process.env.AI_API_URL || '',
  apiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  maxTokens: parseInt(process.env.AI_MAX_TOKENS) || 1024,
  temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,
};

async function chat(messages, options = {}) {
  if (!config.enabled || !config.apiUrl || !config.apiKey) {
    return { error: 'AI 未启用，请配置环境变量' };
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      // OpenRouter 推荐头部
      'HTTP-Referer': 'http://localhost:5301',
      'X-Title': 'KuGou Music Player',
    };

    const resp = await axios.post(`${config.apiUrl}/chat/completions`, {
      model: options.model || config.model,
      messages,
      max_tokens: options.maxTokens || config.maxTokens,
      temperature: options.temperature ?? config.temperature,
    }, {
      headers,
      timeout: 60000,
      proxy: false,
    });

    return {
      success: true,
      content: resp.data?.choices?.[0]?.message?.content || '',
      usage: resp.data?.usage || {},
      model: resp.data?.model || '',
    };
  } catch (e) {
    return { error: `AI 请求失败: ${e.response?.data?.error?.message || e.message}`, status: e.response?.status };
  }
}

// ===== 智能推荐 =====

async function smartRecommend(userProfile, playHistory, limit = 15) {
  const prompt = `你是一个专业的音乐推荐助手。根据以下用户听歌数据，推荐可能喜欢的歌曲。

用户画像：
- 总播放次数：${userProfile.total_plays || 0}
- 累计收听：${userProfile.total_listen_min || 0} 分钟

常听歌手（偏好分数从高到低）：
${(userProfile.top_singers || []).slice(0, 5).map(s => `- ${s.vector_key}: ${s.score?.toFixed(1) || 0}分 (${s.play_count || 0}次)`).join('\n') || '暂无数据'}

偏好语种：
${(userProfile.language_prefs || []).map(l => `- ${l.vector_key}: ${l.score?.toFixed(1) || 0}分`).join('\n') || '暂无数据'}

近期播放历史：
${(playHistory || []).slice(0, 15).map((h, i) => `${i+1}. ${h.songname} - ${h.singername}`).join('\n') || '暂无记录'}

请推荐 ${limit} 首可能喜欢的歌曲（必须是真实存在的歌曲）。

返回纯 JSON 数组格式，每首包含：
- songname: 歌曲名
- singername: 歌手名
- reason: 推荐理由（简短一句话）

只返回 JSON 数组，不要任何解释文字。格式示例：
[{"songname":"晴天","singername":"周杰伦","reason":"你常听华语流行，这首经典歌曲很适合"}]`;

  const result = await chat([
    { role: 'system', content: '你是一个专业的音乐推荐助手，擅长根据用户听歌习惯推荐合适的歌曲。请严格只返回 JSON 数组。' },
    { role: 'user', content: prompt },
  ]);

  if (result.success) {
    try {
      const jsonMatch = result.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) return { success: true, recommendations: JSON.parse(jsonMatch[0]), model: result.model };
    } catch (e) {
      return { error: 'AI 返回格式解析失败', raw: result.content?.slice(0, 200) };
    }
  }
  return result;
}

// ===== 歌词情感分析 =====

async function analyzeLyric(lyricText) {
  const prompt = `分析以下歌词的情感主题和意境，用简洁的中文描述（不超过 50 字）：\n\n${(lyricText || '').slice(0, 1500)}`;

  const result = await chat([
    { role: 'system', content: '你是一个音乐鉴赏家，擅长分析歌词的情感和意境。' },
    { role: 'user', content: prompt },
  ], { maxTokens: 128 });

  return result;
}

// ===== 根据心情推荐 =====

async function moodRecommend(mood, userProfile) {
  const moodMap = {
    happy: '欢快、阳光、正能量',
    sad: '伤感、抒情、治愈',
    chill: '放松、悠闲、轻音乐',
    energetic: '激情、动感、摇滚',
    romantic: '浪漫、温柔、情歌',
    nostalgic: '怀旧、经典、回忆',
  };

  const style = moodMap[mood] || '好听的音乐';

  const prompt = `用户现在的心情是「${mood}」，偏好风格：${style}。

用户常听的歌手：${(userProfile.top_singers || []).map(s => s.vector_key).join('、') || '未知'}

请推荐 10 首适合当前心情的真实歌曲，返回 JSON 数组格式，每首包含：songname, singername, reason（为什么适合这个心情）。
只返回 JSON 数组，不要其他文字。`;

  const result = await chat([
    { role: 'system', content: '你是一个贴心的音乐推荐助手，擅长根据用户心情推荐合适的真实存在的歌曲。请严格只返回 JSON 数组。' },
    { role: 'user', content: prompt },
  ]);

  if (result.success) {
    try {
      const jsonMatch = result.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) return { success: true, recommendations: JSON.parse(jsonMatch[0]), mood, model: result.model };
    } catch (e) {}
  }
  return result;
}

module.exports = { config, chat, smartRecommend, analyzeLyric, moodRecommend };
