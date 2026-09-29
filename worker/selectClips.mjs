const MODEL = process.env.EDIT_MODEL || 'gpt-5';
const MAX_CLIPS = 60;
const MIN_CLIP = 4;

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

function buildPrompt({ transcript, payload, duration, retryNote }) {
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
    retryNote ? `\n## 재시도 사유\n${retryNote}\n거부된 내용을 수정하고 다시 선택하세요.` : '',
    '',
    `## 시간표시가 있는 전사 (영상 길이 ${hhmmss(transcript.duration)}, 발화 ${transcript.segments.length}개)`,
    renderTranscript(transcript.segments),
    '',
    '## 최종 확인',
    rules.map((rule) => `- ${rule}`).join('\n'),
  ].join('\n');
}

async function askModel(prompt) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: prompt,
      text: { format: schema },
      max_output_tokens: 16000,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI 구간 선택: ${data.error?.message || response.status}`);
  if (data.status === 'incomplete') {
    throw new Error(`AI 응답이 잘렸습니다 (${data.incomplete_details?.reason || 'unknown'}).`);
  }
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!text) throw new Error('AI가 편집 구간을 반환하지 않았습니다.');
  return JSON.parse(text);
}

function resolve(plan, transcript) {
  const byId = new Map(transcript.segments.map((segment) => [segment.id, segment]));
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
    const end = Math.min(Number(transcript.duration), Number(endSegment.end) + 0.6);
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

function fitBudget(clips, duration) {
  const total = (items) => items.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  let kept = [...clips];
  if (total(kept) <= duration) return kept;

  const optional = kept.filter((clip) => clip.priority === 2).sort((a, b) => (b.end - b.start) - (a.end - a.start));
  for (const drop of optional) {
    if (total(kept) <= duration) break;
    kept = kept.filter((clip) => clip !== drop);
  }
  if (total(kept) <= duration) return kept;

  const minimumTotal = kept.length * MIN_CLIP;
  if (minimumTotal > duration) {
    throw new Error(`필수 장면 ${kept.length}개를 ${duration}초에 담을 수 없습니다. 목표 길이를 ${Math.ceil(minimumTotal)}초 이상으로 올리거나 요구사항을 좁혀주세요.`);
  }
  const originalTotal = total(kept);
  const factor = (duration - minimumTotal) / (originalTotal - minimumTotal);
  for (const clip of kept) {
    const originalLength = clip.end - clip.start;
    clip.end = clip.start + MIN_CLIP + (originalLength - MIN_CLIP) * factor;
  }
  return kept;
}

export async function selectClips({ transcript, payload, duration }) {
  if (!transcript.segments?.length) throw new Error('전사에서 편집할 발화를 찾지 못했습니다.');
  let retryNote = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let plan;
    try {
      plan = await askModel(buildPrompt({ transcript, payload, duration, retryNote }));
    } catch (error) {
      retryNote = error.message;
      if (attempt === 3) throw error;
      continue;
    }

    const { clips, rejected } = resolve(plan, transcript);
    if (clips.length && rejected.length <= clips.length) {
      const fitted = fitBudget(clips, duration);
      if (fitted.length) return fitted.slice(0, MAX_CLIPS);
    }
    retryNote = rejected.slice(0, 10).join('\n') || '유효한 구간을 선택하지 않았습니다.';
    if (attempt === 3) throw new Error(`AI가 유효한 편집 구간을 고르지 못했습니다. ${retryNote}`);
  }
  throw new Error('AI가 편집 구간을 결정하지 못했습니다.');
}
