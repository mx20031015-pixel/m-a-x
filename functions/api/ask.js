import { 대상, 하는일, 기준, 멈춤, 모델 } from "../_config.js";

function 글로(x) {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return x.map(글로).filter(Boolean).join("\n");
  if (typeof x === "object") {
    for (const k of ["response", "text", "output_text", "content", "message", "result"]) {
      if (x[k] !== undefined) {
        const value = 글로(x[k]);
        if (value.trim()) return value;
      }
    }
    try { return JSON.stringify(x); } catch { return ""; }
  }
  return "";
}

function 모델출력(결과) {
  // Workers AI 응답은 모델/런타임에 따라 response 또는 result 안에 들어올 수 있습니다.
  let 현재 = 결과;
  for (let i = 0; i < 4 && 현재 && typeof 현재 === "object"; i++) {
    if (현재.response !== undefined) { 현재 = 현재.response; continue; }
    if (현재.result !== undefined) { 현재 = 현재.result; continue; }
    if (현재.output_text !== undefined) { 현재 = 현재.output_text; continue; }
    break;
  }
  return 현재;
}

function 구조화(원문) {
  if (원문 && typeof 원문 === "object" && !Array.isArray(원문)) {
    if (typeof 원문.text === "string" || typeof 원문.status === "string") return 원문;
  }
  if (typeof 원문 === "string") {
    const start = 원문.indexOf("{");
    const end = 원문.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(원문.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch {
    return Response.json({ 상태: "오류", 내용: "요청 내용을 읽지 못했습니다. 다시 시도해 주세요." }, { status: 400 });
  }

  const rawInput = typeof body?.입력 === "string" ? body.입력 : (typeof body?.输入 === "string" ? body.输入 : "");
  const 입력 = rawInput.trim();
  const 언어 = body?.언어 === "ko" ? "ko" : "zh";
  const 이미지 = Array.isArray(body?.이미지) ? body.이미지.slice(0, 3) : [];

  if (입력.length < 5 && 이미지.length === 0) {
    return Response.json({ 상태: "물음", 내용: "인터뷰 주제나 분석할 파일 내용을 입력해 주세요." });
  }

  const 이미지설명 = [];
  for (let i = 0; i < 이미지.length; i++) {
    const item = 이미지[i];
    if (!item || typeof item.data !== "string" ||
        !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(item.data) ||
        item.data.length > 3_000_000) continue;
    try {
      const encoded = item.data.slice(item.data.indexOf(",") + 1);
      const binary = atob(encoded);
      const imageBytes = Array.from(binary, c => c.charCodeAt(0));
      const vision = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        prompt: "이미지의 내용과 읽을 수 있는 글자를 정확하게 설명하세요. 보이지 않는 정보는 추측하지 마세요.",
        image: imageBytes,
        max_tokens: 700,
      });
      const 설명 = 글로(모델출력(vision)).trim();
      if (설명) 이미지설명.push("이미지 " + (i + 1) + " (" + String(item.name || "첨부 이미지").slice(0, 100) + "):\n" + 설명);
    } catch {
      return Response.json({
        상태: "오류",
        내용: "이미지 분석에 실패했습니다. Cloudflare Workers AI의 Vision 모델 사용 권한과 Meta 라이선스 동의 여부를 확인해 주세요."
      }, { status: 503 });
    }
  }

  const 언어지시 = 언어 === "ko"
    ? "반드시 자연스러운 한국어로 답변하세요."
    : "请始终使用简体中文回答。";
  const 지시문 = `당신은 전문 AI 인터뷰 도우미입니다.
[사용자] ${대상.trim()}
[업무] ${하는일.trim()}
[품질 기준]
${기준.map((x, i) => (i + 1) + ". " + x).join("\n")}
[주의 사항]
${멈춤.trim()}

${언어지시}
사용자가 선택한 작업 모드와 요청을 우선 수행하세요.
첨부 문서에서 읽은 내용을 실제 자료로 취급하되, 자료에 없는 사실은 만들지 마세요.
문서가 길면 핵심 내용을 빠뜨리지 않도록 주제별로 정리하세요.
필요한 경우 제목과 번호 목록을 사용해 읽기 쉽게 작성하세요.
답변은 반드시 일반 텍스트로 작성하고, 빈 답변을 반환하지 마세요.`;

  const 최종입력 = 입력 + (이미지설명.length
    ? "\n\n[업로드 이미지에서 확인한 내용]\n" + 이미지설명.join("\n\n")
    : "");

  try {
    const 결과 = await env.AI.run(모델, {
      messages: [
        { role: "system", content: 지시문 },
        { role: "user", content: 최종입력 },
      ],
      max_tokens: 1800,
    });

    const 원문 = 모델출력(결과);
    const 객체 = 구조화(원문);
    const 내용 = 객체 && typeof 객체.text === "string"
      ? 객체.text.trim()
      : 글로(원문).trim();

    if (!내용) {
      return Response.json({
        상태: "오류",
        내용: "AI 모델이 빈 결과를 반환했습니다. 입력 파일의 텍스트가 추출되었는지 확인한 뒤 다시 시도해 주세요."
      }, { status: 502 });
    }

    return Response.json({
      상태: 객체?.status === "ask" ? "물음" : "답",
      내용,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({
      상태: "오류",
      내용: "AI 분석 요청에 실패했습니다. 실제 오류: " + detail.slice(0, 500)
    }, { status: 503 });
  }
}
