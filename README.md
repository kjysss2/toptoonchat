# 탑툰챗 카운터

공개된 [탑툰챗 랭킹](https://chat.toptoon.com/ranking)을 하루 한 번 저장해, 캐릭터별 랭킹 흐름과 신규 진입을 보는 정적 투자 리서치 대시보드입니다.

## 보는 지표

- 최신 순위와 공개 랭킹 점수
- 7일·30일 순위 변화
- 신규 진입, Top 10 유지율, 급등 캐릭터
- 최근 30일 Top 4 순위 흐름

공개 랭킹은 절대 매출·MAU·ARPPU가 아닙니다. 이 프로젝트는 공개 순위의 **방향성 프록시**만 제공합니다.

## 수집 방식

- 대상: `https://chat.toptoon.com/ranking`
- 빈도: 매일 08:00 KST (`23:00 UTC`)
- 방식: 로그인 없이 공개 HTML 1회 요청, `robots.txt` 허용 경로만 사용
- 저장: `dist/data/snapshots.json`에 일별 스냅샷 추가

GitHub Actions의 `schedule`은 대기열 상황에 따라 몇 분 늦게 시작될 수 있습니다. 한 번에 같은 한국 날짜의 스냅샷이 두 개 생기면 최신 수집값으로 교체합니다.

## 배포

`main` 브랜치에 반영되면 `.github/workflows/deploy-pages.yml`이 `dist/`를 GitHub Pages로 배포합니다. 처음 한 번만 저장소 **Settings → Pages**에서 배포 원본을 **GitHub Actions**로 허용하면 됩니다.

수집을 즉시 실행하려면 Actions 탭의 **Capture Toptoon Chat ranking**에서 **Run workflow**를 누르면 됩니다.
