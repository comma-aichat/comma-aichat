// 오리지널 캐릭터 일러스트 생성 (관리자 전용)
// 무료 이미지 생성(pollinations)으로 그림을 만들어 저장소에 올리고, 필요하면 캐릭터 이미지로 지정한다.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

function b64(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { data: tok } = await admin.rpc("get_app_secret", { secret_name: "ADMIN_TOKEN" });
  if (!tok || body.token !== tok) return json({ error: "forbidden" }, 403);

  const slug = String(body.slug || "").replace(/[^a-z0-9-]/g, "");
  if (!slug) return json({ error: "slug" }, 400);

  // 이미 만든 그림을 캐릭터에 지정만 하는 경우
  if (body.apply_path) {
    const path = String(body.apply_path);
    const { data: pub } = admin.storage.from("character-images").getPublicUrl(path);
    const { error } = await admin.from("characters").update({ image_url: pub.publicUrl }).eq("slug", slug).eq("is_official", true);
    return json({ ok: !error, url: pub.publicUrl, error: error?.message });
  }

  // 오리지널 그림 아래쪽(워터마크) 잘라내기
  if (Array.isArray(body.crop)) {
    const out: any[] = [];
    for (const item of body.crop) {
      const { data } = await admin.storage.from("character-images").download(String(item.path));
      if (!data) { out.push({ path: item.path, error: "missing" }); continue; }
      const im = await Image.decode(new Uint8Array(await data.arrayBuffer()));
      const cut = Number(body.cut) || 56;
      im.crop(0, 0, im.width, im.height - cut);
      const np = String(item.path).replace(/\.jpg$/, "-c.jpg");
      const up = await admin.storage.from("character-images").upload(np, await im.encodeJPEG(90), { contentType: "image/jpeg", upsert: true });
      if (up.error) { out.push({ path: item.path, error: up.error.message }); continue; }
      const url = admin.storage.from("character-images").getPublicUrl(np).data.publicUrl;
      const { error } = await admin.from("characters").update({ image_url: url }).eq("slug", String(item.slug)).eq("is_official", true);
      out.push({ slug: item.slug, url, error: error?.message });
    }
    return json({ ok: true, out });
  }

  // 여러 그림을 한 장에 모아 작은 미리보기로 (확인용)
  if (Array.isArray(body.montage)) {
    const cw = Number(body.tw) || 110, ch = Math.round(cw * 1.25), cols = Number(body.cols) || 5;
    const rows = Math.ceil(body.montage.length / cols);
    const sheet = new Image(cw * cols, ch * rows);
    sheet.fill(0x111111ff);
    for (let i = 0; i < body.montage.length; i++) {
      const { data } = await admin.storage.from("character-images").download(String(body.montage[i]));
      if (!data) continue;
      const im = await Image.decode(new Uint8Array(await data.arrayBuffer()));
      im.resize(cw, ch);
      sheet.composite(im, (i % cols) * cw, Math.floor(i / cols) * ch);
    }
    return json({ ok: true, thumb: b64(await sheet.encodeJPEG(Number(body.tq) || 55)) });
  }

  const seed = Number(body.seed) || Math.floor(Math.random() * 1e6);
  const w = Number(body.w) || 768, h = Number(body.h) || 960;
  const src = `https://image.pollinations.ai/prompt/${encodeURIComponent(String(body.prompt || ""))}?width=${w}&height=${h}&seed=${seed}&nologo=true&model=${encodeURIComponent(body.model || "flux")}`;
  const r = await fetch(src);
  if (!r.ok) return json({ error: "gen " + r.status }, 502);
  const bytes = new Uint8Array(await r.arrayBuffer());

  const path = `official/${slug}-${seed}.jpg`;
  const up = await admin.storage.from("character-images").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (up.error) return json({ error: up.error.message }, 500);

  // 미리보기용 작은 그림
  let thumb = "";
  if (body.thumb) try {
    const img = await Image.decode(bytes);
    img.resize(Number(body.tw) || 240, Image.RESIZE_AUTO);
    thumb = b64(await img.encodeJPEG(Number(body.tq) || 70));
  } catch (_) { /* 미리보기 실패는 무시 */ }

  return json({ ok: true, path, seed, size: bytes.length, thumb });
});
