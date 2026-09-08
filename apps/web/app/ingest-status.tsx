import type { ApiData } from './server'
import { fmtTime } from './format'

type Status = ApiData<'/ingest/status'>

// traces 페이지 요약 줄 아래 한 줄. 서버가 자기 데이터를 잘 채우고 있는지가 이 페이지의 주제라서.
export function IngestStatus({ status }: { status: Status }) {
  const last = status.recent.find((r) => r.status !== 'running')
  if (!last) return <p className="summary">ingestion: 아직 실행 기록 없음</p>

  const when = fmtTime(String(last.finishedAt ?? last.startedAt))
  return (
    <p className={last.status === 'failed' ? 'state-error' : 'summary'}>
      ingestion: {status.current ? '실행 중 · ' : ''}
      마지막 {last.status === 'done' ? '성공' : '실패'} {when} ({last.trigger})
      {last.status === 'done' && (
        <>
          {' · '}turns +<strong>{last.turns ?? 0}</strong> · gates +<strong>{last.gates ?? 0}</strong>
        </>
      )}
      {last.status === 'failed' && last.error && <> · {last.error}</>}
    </p>
  )
}
