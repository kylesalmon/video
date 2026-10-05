const MODEL = process.env.EDIT_MODEL || 'gpt-5';
const MAX_CLIPS = 60;
const REASONING_EFFORT = process.env.EDIT_REASONING_EFFORT || 'medium';
const MAX_WAIT_MS = 15 * 60 * 1000;
const BUDGET_TOLERANCE = 1.1;

// Named so it is never confused with fetch's own abort error, which is also called TimeoutError.
class EditTimeout extends Error {
  name = 'EditTimeout';
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hhmmss = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 3600)}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

const renderTranscript = (segments) => segments
  .map((segment) => `#${segment.id} [${hhmmss(segment.start)}] ${segment.speaker || '화자 미상'}: ${segment.text}`)
  .join('\n');

const schema = {
  type: 'json_schema',
  name: 'clip_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['clips'],
    properties: {
      clips: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CLIPS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['startId', 'endId', 'priority', 'reason', 'quote'],
          properties: {
            startId: { type: 'integer', description: '구간이 시작되는 발화 번호' },
            endId: { type: 'integer', description: '구간이 끝나는 발화 번호. startId 이상' },
            priority: { type: 'integer', enum: [1, 2], description: '1=필수, 2=목표 길이에 여유가 있을 때만' },
            reason: { type: 'string', description: '이 구간을 고른 이유 한 줄' },
            quote: { type: 'string', description: 'startId 발화에서 그대로 가져온 10자 이상 인용' },
          },
        },
      },
    },
  },
};

function buildPrompt({ transcript, payload, duration }) {
  const rules = [
    `목표 길이 ${duration}초에 맞게 필수(priority 1) 구간을 고르세요. 필수 구간 합은 목표를 넘지 않아야 합니다.`,
    `선택(priority 2) 구간은 추가 후보로 제안하고, 목표 길이 조절 시 먼저 제외합니다.`,
    `발화 ID는 반드시 아래 전사에 존재하는 번호만 사용하세요 (#0~#${transcript.segments.at(-1).id}).`,
    'startId는 장면의 맥락이 시작되는 대사로 고르세요. 리액션만 자르면 원인을 알 수 없으니 원인 발화부터 포함하세요.',
    'quote에는 startId 발화의 일부를 정확히 복사하세요. 요약하거나 바꾸지 마세요.',
    '구간은 겹치지 않게 하고, 원본 시간순으로 반환하세요.',
  ];
  return [
    '당신은 긴 영상의 롱폼 편집자입니다. 편집 지시서의 의도와 전체 맥락을 따르세요.',
    '',
    '## 편집 요구사항',
    payload.instruction || '(없음)',
    '',
    '## 원하는 타임라인',
    payload.timeline || '(없음)',
    '',
    '## 선택 규칙',
    rules.map((rule) => `- ${rule}`).join('\n'),
    '',
    `## 시간표시가 있는 전사 (영상 길이 ${hhmmss(transcript.duration)}, 발화 ${transcript.segments.length}개)`,
    renderTranscript(transcript.segments),
    '',
    '## 최종 확인',
    rules.map((rule) => `- ${rule}`).join('\n'),
  ].join('\n');
}

const retryPrompt = (note) => `## 재시도 사유\n${note}\n거부된 구간을 고쳐서 전체 구간 목록을 다시 반환하세요. 규칙과 전사는 처음과 같습니다.`;

const retryable = (message) => Object.assign(new Error(message), { retryable: true });

const openai = async (pathname, { timeoutMs = 30000, ...init } = {}) => {
  let response;
  let data;
  try {
    response = await fetch(`https://api.openai.com/v1/responses${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    // A dropped connection or a slow reply is worth retrying, so it must not fail the whole job.
    const reason = error.name === 'TimeoutError' ? `${Math.round(timeoutMs / 1000)}초 안에 응답이 없었습니다` : error.message;
    throw retryable(`OpenAI 연결이 끊겼습니다 (${reason}).`);
  }
  if (!response.ok && (response.status === 429 || response.status === 408 || response.status >= 500)) {
    throw retryable(`OpenAI 일시 오류 (${response.status}) ${data.error?.message || ''}`.trim());
  }
  // A rejected request fails the same way every time, so the caller must not resend the prompt.
  if (!response.ok) throw Object.assign(new Error(`OpenAI 구간 선택: ${data.error?.message || response.status}`), { apiError: true });
  return data;
};

async function askModel({ input, previousResponseId, effort }, onWait) {
  // Background mode keeps long reasoning runs off a single HTTP request, so no connection timeout applies.
  const create = () => openai('', {
    method: 'POST',
    // Sending a long transcript takes a while, so this is more generous than a status poll.
    timeoutMs: 120000,
    body: JSON.stringify({
      model: MODEL,
      input,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      text: { format: schema },
      reasoning: { effort },
      max_output_tokens: 32000,
      background: true,
    }),
  });
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      data = await create();
      break;
    } catch (error) {
      if (!error.retryable || attempt >= 3) throw error;
      await delay(2000 * attempt);
    }
  }
  const startedAt = Date.now();
  while (data.status === 'queued' || data.status === 'in_progress') {
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      await openai(`/${data.id}/cancel`, { method: 'POST', timeoutMs: 10000 }).catch(() => {});
      throw new EditTimeout(`AI 구간 선택이 ${Math.round(MAX_WAIT_MS / 60000)}분 안에 끝나지 않았습니다. 요구사항을 좁히거나 다시 시도해주세요.`);
    }
    await delay(3000);
    onWait?.(Math.round((Date.now() - startedAt) / 1000));
    try {
      data = await openai(`/${data.id}`);
    } catch (error) {
      // The run keeps going on OpenAI's side, so a failed poll just means checking again.
      if (!error.retryable) throw error;
    }
  }
  if (data.status === 'failed' || data.status === 'cancelled') {
    throw new Error(`OpenAI 구간 선택: ${data.error?.message || data.status}`);
  }
  if (data.status === 'incomplete') {
    throw Object.assign(new Error(`AI 응답이 잘렸습니다 (${data.incomplete_details?.reason || 'unknown'}).`), { incomplete: true });
  }
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!text) throw new Error('AI가 편집 구간을 반환하지 않았습니다.');
  return { plan: JSON.parse(text), responseId: data.id };
}

// Ends a clip just after an utterance, but never past the start of the next one.
function utteranceEnd(byId, transcript, id) {
  const segment = byId.get(id);
  const next = byId.get(id + 1);
  const limit = next ? Math.max(Number(segment.end), Number(next.start)) : Number(transcript.duration);
  return Math.min(Number(segment.end) + 0.6, limit, Number(transcript.duration));
}

function resolve(plan, transcript, byId) {
  const clips = [];
  const rejected = [];

  for (const raw of Array.isArray(plan.clips) ? plan.clips : []) {
    const startSegment = byId.get(raw.startId);
    const endSegment = byId.get(raw.endId);
    if (!startSegment || !endSegment) {
      rejected.push(`#${raw.startId}~#${raw.endId}: 없는 발화 ID`);
      continue;
    }
    if (raw.endId < raw.startId) {
      rejected.push(`#${raw.startId}~#${raw.endId}: 종료 ID가 시작 ID보다 앞섬`);
      continue;
    }
    const normalize = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const quote = normalize(raw.quote);
    const expected = normalize(startSegment.text);
    if (quote.length < 10 || !expected.includes(quote.slice(0, Math.min(quote.length, 20)))) {
      rejected.push(`#${raw.startId}: 시작 대사 인용이 실제 전사와 다름`);
      continue;
    }
    const start = Math.max(0, Number(startSegment.start) - 0.4);
    const end = utteranceEnd(byId, transcript, raw.endId);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      rejected.push(`#${raw.startId}~#${raw.endId}: 유효하지 않은 시간 범위`);
      continue;
    }
    clips.push({
      start,
      end,
      priority: raw.priority === 2 ? 2 : 1,
      reason: String(raw.reason || ''),
      startId: raw.startId,
      endId: raw.endId,
    });
  }

  clips.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const clip of clips) {
    const previous = merged.at(-1);
    if (previous && clip.start < previous.end) {
      previous.end = Math.max(previous.end, clip.end);
      previous.endId = Math.max(previous.endId, clip.endId);
      previous.priority = Math.min(previous.priority, clip.priority);
      if (clip.reason && !previous.reason.includes(clip.reason)) previous.reason += `; ${clip.reason}`;
    } else merged.push(clip);
  }
  return { clips: merged, rejected };
}

function fitBudget(clips, duration, transcript, byId) {
  const total = (items) => items.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  let kept = [...clips];
  if (total(kept) <= duration) return kept;

  const optional = kept.filter((clip) => clip.priority === 2).sort((a, b) => (b.end - b.start) - (a.end - a.start));
  for (const drop of optional) {
    if (total(kept) <= duration) break;
    kept = kept.filter((clip) => clip !== drop);
  }

  // Shorten the longest clip by whole utterances from its tail so no sentence is cut mid-word.
  while (total(kept) > duration) {
    const longest = kept
      .filter((clip) => clip.endId > clip.startId)
      .reduce((best, clip) => (!best || clip.end - clip.start > best.end - best.start ? clip : best), null);
    if (!longest) break;
    longest.endId -= 1;
    longest.end = Math.max(longest.start + 0.5, utteranceEnd(byId, transcript, longest.endId));
  }
  if (total(kept) > duration * BUDGET_TOLERANCE) {
    throw new Error(`필수 장면 ${kept.length}개를 발화 단위로 줄여도 ${Math.ceil(total(kept))}초입니다. 목표 길이를 올리거나 요구사항을 좁혀주세요.`);
  }
  return kept;
}

export async function selectClips({ transcript, payload, duration, onStatus }) {
  if (!transcript.segments?.length) throw new Error('전사에서 편집할 발화를 찾지 못했습니다.');
  const byId = new Map(transcript.segments.map((segment) => [segment.id, segment]));
  const prompt = buildPrompt({ transcript, payload, duration });
  let previousResponseId = null;
  let retryNote = '';
  let effort = REASONING_EFFORT;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result;
    try {
      const label = attempt > 1 ? ` (재시도 ${attempt - 1}/2)` : '';
      // Retries continue the stored conversation, so the full transcript is not sent again.
      result = await askModel(
        { input: previousResponseId ? retryPrompt(retryNote) : prompt, previousResponseId, effort },
        (seconds) => onStatus?.(`AI가 편집 구간을 고르는 중입니다${label} · ${seconds}초 경과`),
      );
    } catch (error) {
      // Re-sending the same prompt after the whole budget ran out would only repeat the wait.
      if (attempt === 3 || error.name === 'EditTimeout' || error.apiError) throw error;
      // Truncation means reasoning used up the output budget, so try again with lighter reasoning.
      if (error.incomplete) effort = 'low';
      continue;
    }

    const { clips, rejected } = resolve(result.plan, transcript, byId);
    if (clips.length && rejected.length <= clips.length) {
      const fitted = fitBudget(clips, duration, transcript, byId);
      if (fitted.length) return fitted.slice(0, MAX_CLIPS);
    }
    retryNote = rejected.slice(0, 10).join('\n') || '유효한 구간을 선택하지 않았습니다.';
    previousResponseId = result.responseId;
    if (attempt === 3) throw new Error(`AI가 유효한 편집 구간을 고르지 못했습니다. ${retryNote}`);
  }
  throw new Error('AI가 편집 구간을 결정하지 못했습니다.');
}
