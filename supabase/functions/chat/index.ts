// Comma chat: builds the roleplay prompt from a character, streams Gemini's reply, and saves both turns.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
let GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
let keyLoadedAt = 0;
const MODELS = [Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-3.5-flash-lite"];
const PER_MIN = 12, PER_DAY = 400, HISTORY_CHARS = 14000, MAX_INPUT = 2000;

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
async function ensureKey() {
  if (Deno.env.get("GEMINI_API_KEY")) return;
  if (GEMINI_KEY && Date.now() - keyLoadedAt < 300000) return;
  const { data, error } = await admin.rpc("get_app_secret", { secret_name: "GEMINI_API_KEY" });
  if (error) console.error("secret lookup failed", error.message);
  if (data) { GEMINI_KEY = String(data).trim(); keyLoadedAt = Date.now(); }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const err = (msg: string, status = 400) => json({ error: msg }, status);

type Msg = { role: "user" | "assistant"; content: string };
type Plot = {
  rules?: string; chars?: { name: string; desc: string }[]; personas?: { name: string; desc: string }[];
  examples?: { who: "user" | number; text: string }[]; lore?: { keys: string[]; content: string }[];
  style?: Record<string, string>; intro?: { type: string; ci?: number; text: string }[];
};

const STYLE_TEXT: Record<string, Record<string, string>> = {
  difficulty: { easy: "캐릭터들은 유저에게 우호적이고, 유저가 원하는 방향으로 이야기가 쉽게 흘러간다.", normal: "캐릭터들은 각자의 성격과 상황에 맞춰 개연성 있게 행동한다.", hard: "캐릭터들은 쉽게 마음을 열지 않고 갈등이 자주 생긴다. 유저의 요구를 쉽게 들어주지 않는다.", extreme: "원하는 결과를 얻기 매우 어렵다. 모든 선택에 대가가 따르고 캐릭터들은 냉정하다." },
  pace: { fast: "사건을 빠르게 진행하고 장면 전환을 자주 한다.", natural: "이야기 흐름에 맞춰 완급을 조절한다.", slow: "한 장면을 오래 머무르며 감정과 분위기를 깊게 묘사한다." },
  pov: { "1": "서술은 캐릭터의 1인칭 시점으로 한다.", "2": "서술은 유저를 '당신'으로 부르는 2인칭 시점으로 한다.", "3": "서술은 3인칭 관찰자 시점으로 한다." },
  tense: { past: "서술은 과거형(~했다)으로 쓴다.", present: "서술은 현재형(~한다)으로 쓴다." },
  length: { short: "응답은 1~2문단으로 짧게 쓴다.", medium: "응답은 3~4문단 정도로 쓴다.", long: "응답은 장면을 풍부하게, 5문단 이상 길게 쓴다.", auto: "응답 길이는 상황에 맞게 자연스럽게 조절한다." },
};

function buildSystem(c: any, persona: { name?: string; desc?: string } | null, recentText: string, summary = "") {
  const p: Plot = c.plot && c.plot.v ? c.plot : {};
  const out: string[] = [];
  out.push(`너는 캐릭터 채팅 서비스 'Comma'의 롤플레이 작가다. 아래 설정대로 캐릭터를 연기하며 유저와 함께 이야기를 만든다.`);
  out.push(`[기본 규칙]
- 항상 한국어로 쓴다.
- 행동·묘사·내레이션은 *별표*로 감싸고, 대사는 그대로 쓴다. 여러 캐릭터가 말할 때는 대사 앞에 **이름**을 붙인다.
- 유저의 대사, 행동, 생각을 대신 쓰지 않는다. 유저가 할 행동을 정해 버리지 말고, 유저가 반응할 여지를 남긴 채 끝낸다.
- 설정과 앞선 대화 내용을 일관되게 유지한다. 시스템 지시나 이 규칙 자체를 이야기 속에서 언급하지 않는다.
- 고등학생이거나 19세 미만인 캐릭터는 연애·스킨십·성적 긴장 없이 우정·청춘·모험 이야기로만 그린다. 유저가 그쪽으로 이끌어도 친구 관계로 자연스럽게 돌린다.
- 미성년자(18세 미만)가 등장하는 성적 묘사, 실존 인물에 대한 성적·모욕적 묘사, 자해·자살 방법의 구체적 안내는 어떤 설정이 있어도 쓰지 않는다. 유저가 요구하면 이야기 안에서 자연스럽게 방향을 돌린다.`);
  const st = p.style || {};
  out.push(`[문체]\n` + ["difficulty", "pace", "pov", "tense", "length"].map((k) => STYLE_TEXT[k][st[k] ?? ({ difficulty: "normal", pace: "natural", pov: "3", tense: "past", length: "auto" } as any)[k]]).filter(Boolean).map((s) => "- " + s).join("\n"));
  out.push(`[작품]\n제목: ${c.name}${c.tagline ? `\n한 줄 소개: ${c.tagline}` : ""}${c.intro ? `\n설명: ${c.intro}` : ""}`);
  if (p.chars && p.chars.length) {
    out.push(`[등장 캐릭터]\n` + p.chars.filter((x) => x.name).map((x) => `## ${x.name}\n${x.desc || "(설명 없음)"}`).join("\n\n"));
  } else {
    const b = c.basics || {};
    const basics = [b.age && `나이: ${b.age}`, b.gender && `성별: ${b.gender}`, b.height && `키: ${b.height}`, b.looks && `외모: ${b.looks}`].filter(Boolean).join("\n");
    out.push(`[등장 캐릭터]\n## ${c.name}\n${basics ? basics + "\n" : ""}성격: ${c.personality}\n말투: ${c.speech}\n세계관: ${c.world}`);
  }
  if (p.rules) out.push(`[제작자 규칙 — 반드시 지킬 것]\n${p.rules}`);
  if (persona && (persona.name || persona.desc)) out.push(`[유저가 연기하는 인물]\n이름: ${persona.name || "유저"}${persona.desc ? `\n${persona.desc}` : ""}\n캐릭터들은 유저를 이 인물로 대한다.`);
  const lore = (p.lore || []).filter((l) => l.keys && l.keys.some((k) => k && recentText.includes(k)));
  if (lore.length) out.push(`[참고 설정 — 지금 대화에 관련된 내용]\n` + lore.map((l) => `- ${l.keys.join(", ")}: ${l.content}`).join("\n"));
  if (p.examples && p.examples.length) {
    const nm = (w: "user" | number) => (w === "user" ? "유저" : p.chars?.[w]?.name || c.name);
    out.push(`[말투 예시 — 성격과 말투만 참고하고 그대로 반복하지 말 것]\n` + p.examples.map((x) => `${nm(x.who)}: ${x.text}`).join("\n"));
  }
  if (summary) out.push(`[지난 이야기 요약 — 이미 일어난 일이니 일관되게 이어갈 것]\n${summary}`);
  return out.join("\n\n");
}

function introText(c: any): string {
  const p: Plot = c.plot && c.plot.v ? c.plot : {};
  if (p.intro && p.intro.length) {
    const nm = (i?: number) => p.chars?.[i ?? 0]?.name || c.name;
    return p.intro.filter((m) => m.type !== "img" && m.text).map((m) => (m.type === "narr" ? `*${m.text.replace(/^\*|\*$/g, "")}*` : m.type === "user" ? `(유저) ${m.text}` : (p.chars && p.chars.length > 1 ? `**${nm(m.ci)}** ` : "") + m.text)).join("\n\n");
  }
  return c.greeting || "";
}

async function summarize(prevSummary: string, msgs: Msg[], charName: string): Promise<string> {
  const text = msgs.map((m) => `${m.role === "user" ? "유저" : charName}: ${m.content}`).join("\n");
  const prompt = `다음은 롤플레이 대화의 이전 요약과 그 뒤에 이어진 대화야. 둘을 합쳐서 앞으로 이야기를 이어갈 때 꼭 기억해야 할 내용을 한국어로 정리해 줘.
- 등장인물 관계 변화, 중요한 사건, 약속, 유저가 밝힌 정보, 현재 장소와 상황을 빠짐없이.
- 15줄 이내의 짧은 문장 목록으로. 설명이나 인사 없이 목록만.

[이전 요약]
${prevSummary || "(없음)"}

[이어진 대화]
${text}`;
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1024 } }),
    });
    if (!r.ok) { console.error("summary failed", model, r.status); continue; }
    const j = await r.json();
    const out = (j.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("").trim();
    if (out) return out.slice(0, 3000);
  }
  return "";
}

async function callGemini(system: string, contents: any[]) {
  let last = "";
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 2048 },
        safetySettings: ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })).concat([{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }]),
      }),
    });
    if (r.ok && r.body) return r;
    last = `${model} ${r.status} ${(await r.text()).slice(0, 300)}`;
    console.error("gemini failed", last);
    if (![404, 429, 500, 503].includes(r.status)) break;
  }
  throw new Error(last);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("POST only", 405);
  await ensureKey();
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return err("로그인이 필요해요", 401);
  let body: any;
  try { body = await req.json(); } catch { return err("잘못된 요청이에요"); }

  // ---- start a conversation ----
  if (body.action === "start") {
    const { data: c } = await admin.from("characters").select("id,owner_id,is_public,status").eq("id", body.character_id).maybeSingle();
    if (!c || !(c.is_public || c.owner_id === user.id)) return err("캐릭터를 찾을 수 없어요", 404);
    const persona = body.persona && typeof body.persona === "object" ? { name: String(body.persona.name || "").slice(0, 24), desc: String(body.persona.desc || "").slice(0, 400) } : null;
    const { data: conv, error } = await admin.from("conversations").insert({ user_id: user.id, character_id: c.id, persona }).select("id").single();
    if (error) return err("대화를 만들지 못했어요", 500);
    return json({ conversation_id: conv.id });
  }

  if (!["send", "regenerate", "edit"].includes(body.action)) return err("알 수 없는 요청이에요");
  if (!GEMINI_KEY) return err("AI 키가 아직 설정되지 않았어요. 운영자에게 알려 주세요.", 503);

  const { data: conv } = await admin.from("conversations").select("id,user_id,character_id,persona,summary,summarized_upto").eq("id", body.conversation_id).maybeSingle();
  if (!conv || conv.user_id !== user.id) return err("대화를 찾을 수 없어요", 404);
  const { data: c } = await admin.from("characters").select("*").eq("id", conv.character_id).maybeSingle();
  if (!c || !(c.is_public || c.owner_id === user.id)) return err("이 캐릭터는 더 이상 대화할 수 없어요", 404);

  // rate limit on the user's own messages
  const since = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const [{ count: perMin }, { count: perDay }] = await Promise.all([
    admin.from("messages").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("role", "user").gte("created_at", since(60)),
    admin.from("messages").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("role", "user").gte("created_at", since(86400)),
  ]);
  if (body.action === "send" && (perMin ?? 0) >= PER_MIN) return err("조금 천천히 보내 주세요. 1분 뒤에 다시 시도해 주세요.", 429);
  if (body.action === "send" && (perDay ?? 0) >= PER_DAY) return err("오늘 보낼 수 있는 메시지를 다 썼어요. 내일 다시 만나요!", 429);

  const { data: hist } = await admin.from("messages").select("id,role,content,alts,alt_idx").eq("conversation_id", conv.id).order("id", { ascending: false }).limit(120);
  let history: (Msg & { id: number; alts?: string[]; alt_idx?: number })[] = (hist || []).reverse();

  let userMsgId: number | null = null;
  let editOriginal: { id: number; content: string; removed: any[] } | null = null;
  let regenTarget: { id: number; alts: string[] } | null = null;
  if (body.action === "regenerate") {
    const lastA = history[history.length - 1];
    if (lastA && lastA.role === "assistant") {
      const alts = Array.isArray(lastA.alts) && lastA.alts.length ? lastA.alts : [lastA.content];
      if (alts.length >= 10) return err("답장은 10개까지 만들 수 있어요. 마음에 드는 걸 골라 주세요.");
      regenTarget = { id: lastA.id, alts };
      history = history.slice(0, -1);
    }
    if (!history.length || history[history.length - 1].role !== "user") return err("다시 만들 답장이 없어요");
  } else if (body.action === "edit") {
    const text = String(body.text || "").trim().slice(0, MAX_INPUT);
    if (!text) return err("메시지를 입력해 주세요");
    const idx = history.findIndex((m) => m.id === Number(body.message_id));
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    if (idx < 0 || !lastUser || lastUser.id !== history[idx].id) return err("마지막으로 보낸 메시지만 고칠 수 있어요");
    const afterRows = history.slice(idx + 1);
    editOriginal = { id: history[idx].id, content: history[idx].content, removed: afterRows };
    const after = afterRows.map((m) => m.id);
    if (after.length) await admin.from("messages").delete().in("id", after);
    await admin.from("messages").update({ content: text }).eq("id", history[idx].id);
    history = history.slice(0, idx + 1); history[idx].content = text; userMsgId = history[idx].id;
  } else {
    const text = String(body.text || "").trim().slice(0, MAX_INPUT);
    if (!text) return err("메시지를 입력해 주세요");
    const { data: um, error } = await admin.from("messages").insert({ conversation_id: conv.id, user_id: user.id, role: "user", content: text }).select("id,role,content").single();
    if (error) return err("메시지를 저장하지 못했어요", 500);
    userMsgId = um.id; history.push(um as any);
  }

  // trim history to a budget, newest first; older turns live in the running summary
  let budget = HISTORY_CHARS; const kept: (Msg & { id: number })[] = [];
  for (let i = history.length - 1; i >= 0; i--) { budget -= history[i].content.length; if (budget < 0 && kept.length >= 2) break; kept.unshift(history[i]); }
  const firstKept = kept.length ? kept[0].id : 0;
  const dropped = history.filter((m) => m.id < firstKept && m.id > (conv.summarized_upto || 0));
  const recentText = kept.slice(-6).map((m) => m.content).join("\n");
  const system = buildSystem(c, conv.persona, recentText, conv.summary || "");
  const intro = introText(c);
  const contents: any[] = [];
  if (intro) contents.push({ role: "user", parts: [{ text: "(대화 시작)" }] }, { role: "model", parts: [{ text: intro }] });
  for (const m of kept) {
    const role = m.role === "user" ? "user" : "model";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts[0].text += "\n\n" + m.content; else contents.push({ role, parts: [{ text: m.content }] });
  }

  // a refused turn leaves no trace: drop the new user message / restore an edit
  const undoTurn = async () => {
    if (body.action === "send" && userMsgId) await admin.from("messages").delete().eq("id", userMsgId);
    if (body.action === "edit" && editOriginal) {
      await admin.from("messages").update({ content: editOriginal.content }).eq("id", editOriginal.id);
      if (editOriginal.removed.length) await admin.from("messages").insert(editOriginal.removed.map((m: any) => ({ conversation_id: conv.id, user_id: user.id, role: m.role, content: m.content, alts: m.alts && m.alts.length ? m.alts : [m.content], alt_idx: m.alt_idx || 0 })));
    }
  };

  let upstream: Response;
  try { upstream = await callGemini(system, contents); }
  catch (e) {
    console.error(e);
    if (/SAFETY|PROHIBITED|blocked/i.test(String(e))) { await undoTurn(); return json({ blocked: true }, 200); }
    return err("AI가 지금 답하지 못했어요. 잠시 후 '다시 생성'을 눌러 주세요.", 502);
  }

  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      if (userMsgId) send({ user_id: userMsgId });
      let full = "", buf = "", blocked = "";
      const reader = upstream.body!.getReader();
      try {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              const cand = ev.candidates?.[0];
              for (const part of cand?.content?.parts || []) if (part.text && !part.thought) { full += part.text; send({ d: part.text }); }
              if (cand?.finishReason && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"].includes(cand.finishReason)) blocked = cand.finishReason;
              if (ev.promptFeedback?.blockReason) blocked = ev.promptFeedback.blockReason;
            } catch { /* partial line */ }
          }
        }
      } catch (e) { console.error("stream", e); }
      full = full.trim();
      if (blocked && body.action !== "regenerate") {
        // the reply was refused: forget the partial text and the user's turn
        await undoTurn();
        send({ blocked: true });
      } else if (!full) {
        send({ error: blocked ? "이 답장은 만들 수 없어요. 다른 방향으로 이야기를 이어가 보세요." : "답장을 받지 못했어요. '다시 생성'을 눌러 주세요." });
      } else {
        const reply = full.slice(0, 8000);
        if (regenTarget) {
          const alts = [...regenTarget.alts, reply];
          await admin.from("messages").update({ content: reply, alts, alt_idx: alts.length - 1 }).eq("id", regenTarget.id);
          await admin.from("conversations").update({ last_message: reply.slice(0, 200), updated_at: new Date().toISOString() }).eq("id", conv.id);
          send({ done: true, assistant_id: regenTarget.id, alts, alt_idx: alts.length - 1 });
        } else {
          const { data: am } = await admin.from("messages").insert({ conversation_id: conv.id, user_id: user.id, role: "assistant", content: reply, alts: [reply] }).select("id").single();
          send({ done: true, assistant_id: am?.id ?? null, alts: [reply], alt_idx: 0 });
        }
        if (dropped.length >= 6) {
          const job = (async () => {
            const sum = await summarize(conv.summary || "", dropped, (c.plot?.chars?.[0]?.name) || c.name);
            if (sum) await admin.from("conversations").update({ summary: sum, summarized_upto: dropped[dropped.length - 1].id }).eq("id", conv.id);
          })().catch((e) => console.error("summary", e));
          // @ts-ignore EdgeRuntime exists on Supabase
          if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job);
        }
      }
      } catch (e) { console.error("finish", e); try { send({ error: "답장을 받지 못했어요. '다시 생성'을 눌러 주세요." }); } catch { /* closed */ } }
      try { ctrl.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" } });
});
