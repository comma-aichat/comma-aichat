# Comma

캐릭터와 대화하는 웹앱. 화면은 `index.html` 한 파일이고, 데이터와 로그인은 Supabase, AI 대화는 Supabase Edge Function(`supabase/functions/chat`)이 Gemini를 호출해 처리해요.

- 배포: 이 저장소를 Netlify에 연결하면 `main`에 올라온 변경이 자동으로 사이트에 반영돼요.
- AI 키는 저장소에 넣지 않아요. 서버의 잠긴 저장소(`private.app_secrets`)에 있어요.
