# 가구 스킨 스튜디오

3DAISTUDIO에서 만든 가구 GLB를

1. 품질은 그대로 두고 **가볍게 압축**하고
2. 방석·등받이·프레임·다리 같은 **부분을 자동으로 나눈 뒤**
3. 고른 부분에만 **질감(가죽, 패브릭 등) + 색(hex 코드)** 을 입혀
4. 여러 변형 GLB를 **한 번에** 만드는 도구예요.

공간무드 STUDIO에 올릴 가구 모델을 만드는 데 써요.

## 구성

| 폴더 | 내용 |
| --- | --- |
| `core/segment.js` | 자동 부분 나누기. 방석과 프레임이 만나는 오목한 홈을 따라 자른다. |
| `core/uvbox.js` | 실제 크기 기준 텍스처 좌표(가죽 결·원단 짜임 크기가 어디서나 같게). |
| `core/skin.js` | 부분별 재질 적용, 변형 생성, 압축(meshopt + WebP). |
| `cli/skin.mjs` | 명령줄 도구. |
| `materials/` | 질감 라이브러리(`library.json` + 텍스처). 색은 hex 코드로 곱해서 입힌다. |
| `tools/` | 질감 추가(`add-material.mjs`), 임시 질감 생성(`procedural_textures.py`). |
| `examples/` | job 파일 예시. |

## 명령줄 사용법

Node.js 20 이상이 필요해요.

```bash
npm install

# 1) 부분 나누기 결과 보기 (부분 번호, 크기, 색칠한 미리보기 GLB)
node cli/skin.mjs analyze 소파.glb

# 2) job 파일대로 변형 만들기 (그룹별 선택지의 모든 조합)
node cli/skin.mjs run examples/sofa-job.json

# 3) 재질은 그대로, 용량만 줄이기
node cli/skin.mjs compress 소파.glb
```

### job 파일

```json
{
  "input": "소파.glb",
  "widthMm": 1800,
  "groups": [
    { "name": "쿠션", "parts": [1, 2, 3, 4, 7, 8],
      "choices": [ { "material": "leather-matte", "color": "#8B4A22" } ] }
  ],
  "outDir": "out"
}
```

- `widthMm`: 가구의 실제 가로 길이(mm). 3DAISTUDIO 모델은 크기가 정규화되어 있어서, 가죽 결 크기를 맞추려면 실제 치수가 필요해요.
- `parts`: `analyze`가 알려준 부분 번호. 그룹에 넣지 않은 부분은 원본 그대로 남아요.
- `color`: hex 코드(`#8B4A22`) 또는 `library.json` 팔레트의 색 이름(id).

## 현재 상태

- 질감은 임시로 만든 procedural 재질이에요. 거래처 원단·가죽 사진이 정리되면 진짜 질감으로 바꿔요.
- 브라우저 화면(클릭으로 부분 선택 → 질감 → 색 → 내보내기)은 만드는 중이에요.
