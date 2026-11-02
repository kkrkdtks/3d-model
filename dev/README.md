# 개발용 도구

프로그램을 쓰는 데는 필요 없어요. 부분 나누기나 받침대 나누기를 고칠 때, 예전 결과가 그대로인지 확인하는 시험 도구예요. 공개 저장소라서 실제 가구 GLB는 올리지 않고 따로 보관해요.

## 준비

- 저장소 맨 위에서 `npm install`, `node app/build.mjs` → `dist/skin-studio.html`. 앱 시험은 이 파일을 열어요.
- 앱 시험: Playwright + Chromium (`npm i --no-save playwright && npx playwright install chromium`). 화면 없는 서버에서도 돌아가요 (swiftshader).
- 파일 검사: `npm i --no-save gltf-validator`
- 시험용 가구와 텍스처: Python 3 + numpy + pillow
- Playwright는 한글 경로의 파일을 못 열어요. 시험할 GLB는 영문 이름으로 복사해서 써요.
- 결과는 각 폴더의 `out/`에 생겨요 (저장소에는 안 올라가요).

## furniture/ — 시험용 가구

`gen.py`가 거리 함수(SDF)로 식탁·의자·스툴·벤치·책상·침대·수납장·책장·소파를 사진→3D 도구처럼 한 덩어리 메시로 만들고, 꼭짓점마다 정답(몸체인지 받침대인지)을 같이 저장해요.

```
cd dev/furniture
python3 gen.py                       # 부드러운 이음새 24종 → models/
K=0 SUFFIX=_hard python3 gen.py      # 각진 이음새 (이름 끝 _hard)
node run.mjs --quiet $(cat soft.txt hard.txt extra.txt)   # 정답과 비교: MIXED 0, base-recall 80% 이상
node t30.cjs                         # 앱에서 8종: 받침대 그룹 이름, 블랙 메탈, 내보내기
```

## inspect/ — 실제 모델 점검

| 파일 | 하는 일 |
| --- | --- |
| `levels.mjs a.glb …` | 받침대 높이 후보(아래를 향한 넓은 면)와 그 사이 벽의 밀도 |
| `seg.mjs a.glb` | 받침대 나누기를 끄고 켰을 때 부분 목록 |
| `compare.mjs a.glb …` | 예전 `core/segment.js`(`OLD=경로`)와 지금 버전: 높이와 부분 차이 |
| `colsplit.mjs a.glb` | 모양만 / 색까지 나눈 부분 |
| `shots.cjs a.glb H [폴더]` | 앱 화면: 재질 보기, 부분 보기(옆·아래) |
| `legs.cjs a.glb H 폴더 [W]` | 받침대 그룹에 블랙·화이트 메탈 → 화면, 다리 확대, 내보내기 |
| `closeups.cjs a.glb H 폴더 [개수]` | 받침대 조각(다리)마다 확대 사진 |
| `mat.mjs a.glb` | 재질과 텍스처 정보 |
| `validate.mjs a.glb` | Khronos glTF 검사 |

## app-tests/ — 앱 시험

- v0.5.3에서 통과 (2026-10-30): `t20.cjs plinth.glb sofa.glb` (색으로 나누기, 높이로 나누기, 작업 기록), `t23.cjs sofa.glb` (저장한 나누기 그대로 다시 열기), `t24.cjs green.glb` (코너 소파 다리), `t25.cjs green.glb` (다리에 블랙·화이트 메탈 내보내기), `furniture/t30.cjs`.
- v0.6 재질 (2026-11-02): `t26.cjs 모델.glb H "재질id:#색,재질id:#색" 이름 --parts=all|top|notop|base [--cut=mm] [--export=N]` — 탭마다 재질 카드, 재질마다 전체·확대 화면, 앞의 N개 내보내기. 확인한 것: `sofa.glb 812` (가죽·패브릭 14종), 식탁 상판 `--parts=top` (대리석·나무·유리), 다리 `--parts=notop` (메탈·도장·라탄 등).
- v0.6.1 원래 질감 색만 바꾸기 (2026-11-02): `t27.cjs 모델.glb H "#색,#색" 이름 --parts=all|top|notop|base|nobase [--size=WxD] [--second=base:재질id:#색]` — ‘원래 질감 그대로 · 색만 바꾸기’ 카드, 색마다 전체·확대 화면, 원래 모습 확대, 모두 내보내기. `--second`는 다른 그룹(예: 다리)에 보통 재질을 줘서 한 파일에 섞어 내보내요. 확인한 것: `sofa.glb 812` (전체, 몸체+블랙 메탈 다리), 식탁 상판 `--parts=top --size=2000x900` (빛을 구운 모델).
- 예전 버전 때 만들고 통과, 그 뒤로 다시 돌리지 않음: t9 (식탁 크기), t10 (소파와 삭제, `SOFA=경로`), t11 (어두운 화면·좁은 창), t14–t17 (v0.4 작업 기록, 라이브러리 zip, 제품 사진), t21 (v0.5 화면), t22 (여는 시간).

## 기본 재질 만들기

- 기본 재질의 질감은 `tools/furniture_materials.py`가 계산으로 만들어요 (실제 크기의 무늬 한 장, 요철은 mm 단위). `python3 tools/furniture_materials.py` 전체, `python3 tools/furniture_materials.py fabric-boucle stone-carrara` 일부만 → `materials/`의 WebP와 `library.json`을 고쳐요. `--preview 폴더`는 PNG로만 저장해요.
- 재질 목록 그림: `python3 dev/textures/catalog.py 목록.png` (재질마다 실제 크기, 예시 색)

## textures/ — 색 나누기 시험용 모델

- 받침대만 나무색으로 칠한 소파 (`plinth.glb`): `node dump_band.mjs sofa.glb band.bin 0 0.095` → `python3 paint.py sofa.glb band.bin plinth.jpg` → `node retex.mjs sofa.glb plinth.jpg plinth.glb`
- 반사와 줄무늬가 센 원단: `python3 paint2.py sofa.glb stress`, 또는 `node dump_all.mjs sofa.glb faces.bin` → `python3 paint3.py sofa.glb faces.bin stress` → `retex.mjs`로 입히기
