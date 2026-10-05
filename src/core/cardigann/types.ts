// Shape of a Cardigann YAML definition (the format Jackett and Prowlarr use).
// Full schema: https://github.com/Jackett/Jackett/tree/master/docs
// Only the parts the engine reads are typed; everything is optional-tolerant
// because definitions in the wild are inconsistent.

export type FilterArgs = string | number | boolean | (string | number | boolean)[] | null | undefined

export interface FilterBlock {
  name: string
  args?: FilterArgs
}

export interface SelectorBlock {
  selector?: string
  attribute?: string
  text?: string | number
  remove?: string
  filters?: FilterBlock[]
  case?: Record<string, string | number>
  optional?: boolean
  default?: string | number
}

export interface SelectorField {
  selector: string
  attribute?: string
  filters?: FilterBlock[]
  usebeforeresponse?: boolean
}

export interface SettingsField {
  name: string
  type?: 'text' | 'password' | 'checkbox' | 'select' | 'multi-select' | 'info' | string
  label?: string
  default?: string | number | boolean
  defaults?: string[]
  options?: Record<string, string>
}

export interface CategoryMapping {
  id: string | number
  cat?: string
  desc?: string
  default?: boolean
}

export interface SearchPathBlock {
  path: string
  method?: 'get' | 'post' | string
  inputs?: Record<string, string | number | boolean>
  inheritinputs?: boolean
  followredirect?: boolean
  categories?: (string | number)[]
  response?: { type?: 'html' | 'json' | 'xml'; noResultsMessage?: string }
}

export interface RowsBlock extends SelectorBlock {
  selector: string
  after?: number
  dateheaders?: SelectorBlock
  count?: SelectorBlock
  multiple?: boolean
  missingAttributeEqualsNoResults?: boolean
}

export interface ErrorBlock {
  path?: string
  selector: string
  message?: SelectorBlock
}

export interface SearchBlock {
  path?: string
  paths?: SearchPathBlock[]
  headers?: Record<string, string | string[]>
  inputs?: Record<string, string | number | boolean>
  allowEmptyInputs?: boolean
  keywordsfilters?: FilterBlock[]
  preprocessingfilters?: FilterBlock[]
  error?: ErrorBlock[]
  rows: RowsBlock
  fields: Record<string, SelectorBlock>
}

export interface DownloadBlock {
  selectors?: SelectorField[]
  method?: string
  before?: { path?: string; method?: string; inputs?: Record<string, string>; pathselector?: SelectorField }
  infohash?: { hash: SelectorField; title: SelectorField; usebeforeresponse?: boolean }
  headers?: Record<string, string | string[]>
}

export interface LoginBlock {
  path?: string
  submitpath?: string
  method?: 'form' | 'post' | 'get' | 'cookie' | 'oneurl' | string
  form?: string
  /** For `form`: input keys are CSS selectors rather than field names */
  selectors?: boolean
  inputs?: Record<string, string | number | boolean>
  selectorinputs?: Record<string, SelectorBlock>
  getselectorinputs?: Record<string, SelectorBlock>
  cookies?: string[]
  headers?: Record<string, string | string[]>
  error?: ErrorBlock[]
  test?: { path: string; selector?: string }
  captcha?: { type: 'image' | 'text' | string; selector: string; input: string }
}

export interface Definition {
  id: string
  name: string
  description?: string
  language?: string
  type: 'public' | 'semi-private' | 'private' | string
  encoding?: string
  requestDelay?: number
  links: string[]
  legacylinks?: string[]
  followredirect?: boolean
  testlinktorrent?: boolean
  caps: {
    categories?: Record<string, string>
    categorymappings?: CategoryMapping[]
    modes?: Record<string, string[]>
    allowrawsearch?: boolean
  }
  settings?: SettingsField[]
  login?: LoginBlock
  search: SearchBlock
  download?: DownloadBlock
}
