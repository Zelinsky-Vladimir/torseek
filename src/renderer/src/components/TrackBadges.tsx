import { BadgeCheck, Captions, Volume2 } from 'lucide-react'
import type { AudioInfo } from '../../../core/audio'
import type { MediaTracks } from '../../../core/media-tracks'
import { t } from '../i18n'
import { Badge } from '../ui'

// Audio / subtitle languages of a release: guessed from its title, or — once the
// release was checked or started downloading — read from the video file itself.

const LABEL: Record<string, string> = {
  en: 'ENG', ru: 'RUS', uk: 'UKR', fr: 'FRA', de: 'GER', es: 'SPA', it: 'ITA', pt: 'POR', pl: 'POL',
  ja: 'JPN', zh: 'CHI', ko: 'KOR', tr: 'TUR', multi: 'MULTI', und: '?',
}
const label = (code: string) => LABEL[code] ?? code.toUpperCase()
const unique = (xs: string[]) => [...new Set(xs)]

function Group({ icon, items, title, good }: { icon: React.ReactNode; items: string[]; title: string; good: (code: string) => boolean }) {
  if (!items.length) return null
  const shown = items.slice(0, 4)
  return (
    <span className="flex shrink-0 items-center gap-1" title={title}>
      {icon}
      {shown.map((code) => (
        <Badge key={code} tone={good(code) ? 'good' : 'neutral'}>
          {label(code)}
        </Badge>
      ))}
      {items.length > shown.length && <span className="text-[11px] text-faint">+{items.length - shown.length}</span>}
    </span>
  )
}

const isEnglish = (code: string) => code === 'en' || code === 'multi'

/** From the release name: a hint, not a promise */
export function TitleTrackBadges({ audio }: { audio: AudioInfo }) {
  const voices = unique([...(audio.multi ? ['multi'] : []), ...audio.langs.filter((l) => l !== 'other')])
  return (
    <>
      <Group icon={<Volume2 className="size-3 text-faint" />} items={voices} title={t('search.audioHint')} good={isEnglish} />
      <Group icon={<Captions className="size-3 text-faint" />} items={audio.subs} title={t('search.subsHint')} good={isEnglish} />
    </>
  )
}

/** From the file's header: what is really there */
export function RealTrackBadges({ tracks }: { tracks: MediaTracks }) {
  const voices = unique(tracks.tracks.filter((x) => x.kind === 'audio').map((x) => x.lang))
  const subs = unique(tracks.tracks.filter((x) => x.kind === 'subtitle').map((x) => x.lang))
  const details = tracks.tracks.map((x) => `${x.kind === 'audio' ? '🔊' : 'CC'} ${label(x.lang)}${x.name ? ` — ${x.name}` : ''}${x.forced ? ' (forced)' : ''}${x.external ? ' (file)' : ''}`).join('\n')
  const title = `${t('tracks.fromFile')}\n${details}`
  if (!voices.length && !subs.length) {
    return <span className="shrink-0 text-[11.5px] text-faint">{t(tracks.container === 'other' ? 'tracks.unknownFormat' : 'tracks.none')}</span>
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={title}>
      <BadgeCheck className="size-3.5 text-good" />
      <Group icon={<Volume2 className="size-3 text-faint" />} items={voices} title={title} good={isEnglish} />
      <Group icon={<Captions className="size-3 text-faint" />} items={subs} title={title} good={isEnglish} />
    </span>
  )
}
