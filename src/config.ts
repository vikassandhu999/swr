import { dequal } from 'dequal/lite'

import { wrapCache } from './cache'
import webPreset from './libs/web-preset'
import { Configuration, RevalidatorOptions, Revalidator } from './types'

const fetcher = (url: string) => fetch(url).then(res => res.json())
const noop = () => {}

// error retry
function onErrorRetry(
  _: unknown,
  __: string,
  config: Readonly<Required<Configuration>>,
  revalidate: Revalidator,
  opts: Required<RevalidatorOptions>
): void {
  if (!webPreset.isDocumentVisible()) {
    // if it's hidden, stop
    // it will auto revalidate when focus
    return
  }

  if (
    typeof config.errorRetryCount === 'number' &&
    opts.retryCount > config.errorRetryCount
  ) {
    return
  }

  // exponential backoff
  const count = Math.min(opts.retryCount, 8)
  const timeout =
    ~~((Math.random() + 0.5) * (1 << count)) * config.errorRetryInterval
  setTimeout(revalidate, timeout, opts)
}

// client side: need to adjust the config
// based on the browser status
// slow connection (<= 70Kbps)
const slowConnection =
  typeof window !== 'undefined' &&
  // @ts-ignore
  navigator['connection'] &&
  // @ts-ignore
  (['slow-2g', '2g'].indexOf(navigator['connection'].effectiveType) !== -1 ||
    // @ts-ignore
    navigator['connection'].saveData)

// config
const defaultConfig = {
  // events
  onLoadingSlow: noop,
  onSuccess: noop,
  onError: noop,
  onErrorRetry,

  // switches
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
  shouldRetryOnError: true,
  suspense: false,

  // timeouts
  errorRetryInterval: (slowConnection ? 10 : 5) * 1000,
  focusThrottleInterval: 5 * 1000,
  dedupingInterval: 2 * 1000,
  loadingTimeout: (slowConnection ? 5 : 3) * 1000,
  refreshInterval: 0,

  // providers
  fetcher,
  compare: dequal,
  isPaused: () => false,
  cache: wrapCache(new Map()),

  // presets
  ...webPreset
} as const

export default defaultConfig
