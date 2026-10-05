import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { HttpClient } from '../src/core/http'
import { LoginRequiredError } from '../src/core/indexer'
import { RuTracker } from '../src/core/native/rutracker'

// Markup mirrors what Jackett's RuTracker.cs selects (tracker.php result table).
const row = `
<tr>
  <td>1</td><td>2</td>
  <td class="f-name-col"><div class="f-name"><a href="tracker.php?f=2093">Фильмы 2011-2015</a></div></td>
  <td class="t-title-col"><div class="t-title"><a class="tLink" href="viewtopic.php?t=555">Дюна / Dune (2021) WEB-DL 1080p</a></div></td>
  <td class="u-name-col">uploader1</td>
  <td class="tor-size" data-ts_text="10737418240"><a class="tr-dl" href="dl.php?t=555">10 GB</a></td>
  <td><b>1234</b></td>
  <td>56</td>
  <td>7890</td>
  <td data-ts_text="1700000000">date</td>
</tr>`

describe('RuTracker', () => {
  it('requests with windows-1251 encoding and parses rows', async () => {
    const urls: string[] = []
    const http = new HttpClient({
      fetch: async (url) => {
        urls.push(url)
        const html = `<div id="logged-in-username">me</div><table id="tor-tbl"><tbody>${row}</tbody></table>`
        return new Response(new Uint8Array(iconv.encode(html, 'windows-1251')), { headers: { 'content-type': 'text/html; charset=windows-1251' } })
      },
    })
    const ix = new RuTracker({ http })
    const [r] = await ix.search({ q: 'дюна 2021' })
    expect(urls[0]).toBe('https://rutracker.org/forum/tracker.php?nm=%E4%FE%ED%E0%252021')
    expect(r).toMatchObject({
      title: 'Дюна / Dune (2021) WEB-DL 1080p',
      details: 'https://rutracker.org/forum/viewtopic.php?t=555',
      link: 'https://rutracker.org/forum/dl.php?t=555',
      size: 10737418240,
      seeders: 1234,
      leechers: 56,
      grabs: 7890,
      publishDate: new Date(1700000000 * 1000).toISOString(),
    })
    expect(r.categories).toContain(2010)
  })

  it('follows result pages from the listing links', async () => {
    const urls: string[] = []
    const page = (n: number) =>
      `<div id="logged-in-username">me</div><table id="tor-tbl"><tbody>${row.replace('t=555', `t=${555 + n}`)}</tbody></table>
       <a class="pg" href="tracker.php?search_id=abc&amp;start=50">2</a><a class="pg" href="tracker.php?search_id=abc&amp;start=100">3</a>`
    const http = new HttpClient({
      fetch: async (url) => {
        urls.push(url)
        const start = Number(new URL(url).searchParams.get('start') ?? 0)
        return new Response(new Uint8Array(iconv.encode(page(start / 50), 'windows-1251')))
      },
    })
    const ix = new RuTracker({ http })
    ix.updateSettings({ pages: '3' })
    const results = await ix.search({ q: 'dune' })
    expect(urls.slice(1)).toEqual(['https://rutracker.org/forum/tracker.php?search_id=abc&start=50', 'https://rutracker.org/forum/tracker.php?search_id=abc&start=100'])
    expect(results).toHaveLength(3)
  })

  it('asks for credentials when the session is not logged in', async () => {
    const http = new HttpClient({ fetch: async () => new Response('<html>guest</html>') })
    await expect(new RuTracker({ http }).search({ q: 'x' })).rejects.toBeInstanceOf(LoginRequiredError)
  })
})
