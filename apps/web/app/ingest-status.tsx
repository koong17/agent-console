import type { ApiData } from './server'
import { fmtTime } from './format'

type Status = ApiData<'/ingest/status'>

// traces 페이지 요약 줄 아래 한 줄. 서버가 자기 데이터를 잘 채우고 있는지가 이 페이지의 주제라서.
export function IngestStatus({ status }: { status: Status }) {
  const last = status.recent.find((r) => r.status !== 'running')
  if (!last) return <p className="summary">ingestion: 아직 실행 기록 없음</p>

  const when = fmtTime(String(last.finishedAt ?? last.startedAt))
  // 삽입 개수만 보면 "0"이 정상인지 고장인지 모른다. 분모로 읽은 줄을 같이 보여준다.
  const lines = last.stats ? last.stats.transcripts.lines + last.stats.events.lines : 0
  return (
    <p className={last.status === 'failed' ? 'state-error' : 'summary'}>
      ingestion: {status.current ? '실행 중 · ' : ''}
      마지막 {last.status === 'done' ? '성공' : '실패'} {when} ({last.trigger})
      {last.status === 'done' && (
        <>
          {' · '}읽은 줄 <strong>{lines.toLocaleString()}</strong> · turns +<strong>{last.turns ?? 0}</strong>{' '}
          · gates +<strong>{last.gates ?? 0}</strong>
          {/* 이미 있던 행의 토큰을 더 큰 값으로 고친 수. 정상 실행에서는 0이라 숨긴다.
              삽입 수(turns +N)와 섞으면 "새로 들어온 양"이 거짓이 된다. */}
          {last.turnsUpdated ? (
            <>
              {' '}
              · turns ~<strong>{last.turnsUpdated.toLocaleString()}</strong>
            </>
          ) : null}
        </>
      )}
      {last.status === 'failed' && last.error && <> · {last.error}</>}
      {/* "turns +0"이 조용한 시간인지 파서가 깨진 건지 구분하는 자리.
          읽은 줄이 많은데 못 알아본 줄이 있으면 여기 뜬다. 0이면 아예 안 보여준다. */}
      {last.unexplained ? (
        <>
          {' · '}
          <span className="status-warning">
            못 알아본 줄 <strong>{last.unexplained.toLocaleString()}</strong>
            {/* 숫자만 보면 DB를 열어야 원인을 안다. 처음 보는 type 이 있으면 이름까지 여기 적는다. */}
            {last.unknownTypes.length > 0 && <> · 처음 보는 type: {last.unknownTypes.join(', ')}</>}
          </span>
        </>
      ) : null}
    </p>
  )
}
