// TODO: use @ts-expect-error
import { useRef, useState, useCallback } from 'react'

import { useIsomorphicLayoutEffect } from './env'
import { serialize } from './libs/serialize'
import useArgs from './resolve-args'
import useSWR from './use-swr'

import {
  KeyLoader,
  Fetcher,
  SWRInfiniteConfiguration,
  SWRInfiniteResponse,
  MutatorCallback
} from './types'

function useSWRInfinite<Data = any, Error = any>(
  ...args:
    | readonly [KeyLoader<Data>]
    | readonly [KeyLoader<Data>, Fetcher<Data> | null]
    | readonly [
        KeyLoader<Data>,
        SWRInfiniteConfiguration<Data, Error> | undefined
      ]
    | readonly [
        KeyLoader<Data>,
        Fetcher<Data> | null,
        SWRInfiniteConfiguration<Data, Error> | undefined
      ]
): SWRInfiniteResponse<Data, Error> {
  const [getKey, fn, config] = useArgs<
    KeyLoader<Data>,
    SWRInfiniteConfiguration<Data, Error>,
    Data
  >(args)
  const cache = config.cache

  const {
    initialSize = 1,
    revalidateAll = false,
    persistSize = false,
    ...extraConfig
  } = config

  // get the serialized key of the first page
  let firstPageKey: string | null = null
  try {
    ;[firstPageKey] = serialize(getKey ? getKey(0, null) : null)
  } catch (err) {
    // not ready
  }

  const rerender = useState({})[1]

  // we use cache to pass extra info (context) to fetcher so it can be globally shared
  // here we get the key of the fetcher context cache
  let contextCacheKey: string | null = null
  if (firstPageKey) {
    contextCacheKey = 'ctx@' + firstPageKey
  }

  // page size is also cached to share the page data between hooks having the same key
  let pageSizeCacheKey: string | null = null
  if (firstPageKey) {
    pageSizeCacheKey = 'len@' + firstPageKey
  }
  const didMountRef = useRef<boolean>(false)

  const resolvePageSize = useCallback((): number => {
    const cachedPageSize = cache.get(pageSizeCacheKey)
    return typeof cachedPageSize !== 'undefined' ? cachedPageSize : initialSize

    // `cache` isn't allowed to change during the lifecycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSizeCacheKey, initialSize])
  // keep the last page size to restore it with the persistSize option
  const lastPageSizeRef = useRef<number>(resolvePageSize())

  // When the page key changes, we reset the page size if it's not persisted
  useIsomorphicLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }

    if (firstPageKey) {
      // If the key has been changed, we keep the current page size if persistSize is enabled
      cache.set(
        pageSizeCacheKey,
        persistSize ? lastPageSizeRef.current : initialSize
      )
    }

    // `initialSize` isn't allowed to change during the lifecycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstPageKey])

  // keep the data inside a ref
  const dataRef = useRef<Data[]>()

  // actual swr of all pages
  const swr = useSWR<Data[], Error>(
    firstPageKey ? ['inf', firstPageKey] : null,
    async () => {
      // get the revalidate context
      const { data: originalData, force } = cache.get(contextCacheKey) || {}

      // return an array of page data
      const data: Data[] = []

      const pageSize = resolvePageSize()
      let previousPageData = null
      for (let i = 0; i < pageSize; ++i) {
        const [pageKey, pageArgs] = serialize(
          getKey ? getKey(i, previousPageData) : null
        )

        if (!pageKey) {
          // pageKey is falsy, stop fetching next pages
          break
        }

        // get the current page cache
        let pageData = cache.get(pageKey)

        // should fetch (or revalidate) if:
        // - `revalidateAll` is enabled
        // - `mutate()` called
        // - the cache is missing
        // - it's the first page and it's not the first render
        // - cache has changed
        const shouldFetchPage =
          revalidateAll ||
          force ||
          typeof pageData === 'undefined' ||
          (typeof force === 'undefined' &&
            i === 0 &&
            typeof dataRef.current !== 'undefined') ||
          (originalData && !config.compare(originalData[i], pageData))

        if (fn && shouldFetchPage) {
          if (pageArgs !== null) {
            pageData = await fn(...pageArgs)
          } else {
            pageData = await fn(pageKey)
          }
          cache.set(pageKey, pageData)
        }

        data.push(pageData)
        previousPageData = pageData
      }

      // once we executed the data fetching based on the context, clear the context
      cache.delete(contextCacheKey)

      // return the data
      return data
    },
    extraConfig
  )

  // update dataRef
  useIsomorphicLayoutEffect(() => {
    dataRef.current = swr.data
  }, [swr.data])

  const mutate = useCallback(
    (data: MutatorCallback, shouldRevalidate = true) => {
      // It is possible that the key is still falsy.
      if (!contextCacheKey) return undefined

      if (shouldRevalidate && typeof data !== 'undefined') {
        // we only revalidate the pages that are changed
        const originalData = dataRef.current
        cache.set(contextCacheKey, { data: originalData, force: false })
      } else if (shouldRevalidate) {
        // calling `mutate()`, we revalidate all pages
        cache.set(contextCacheKey, { force: true })
      }

      return swr.mutate(data, shouldRevalidate)
    },
    // swr.mutate is always the same reference
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextCacheKey]
  )

  // extend the SWR API
  const setSize = useCallback(
    (arg: number | ((size: number) => number)) => {
      // It is possible that the key is still falsy.
      if (!pageSizeCacheKey) return undefined

      let size
      if (typeof arg === 'function') {
        size = arg(resolvePageSize())
      } else if (typeof arg === 'number') {
        size = arg
      }
      if (typeof size === 'number') {
        cache.set(pageSizeCacheKey, size)
        lastPageSizeRef.current = size
      }
      rerender({})
      return mutate(v => v)
    },
    // `cache` and `rerender` isn't allowed to change during the lifecycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageSizeCacheKey, resolvePageSize, mutate]
  )

  // Use getter functions to avoid unnecessary re-renders caused by triggering all the getters of the returned swr object
  const swrInfinite = { size: resolvePageSize(), setSize, mutate }
  Object.defineProperties(swrInfinite, {
    error: {
      get: () => swr.error,
      enumerable: true
    },
    data: {
      get: () => swr.data,
      enumerable: true
    },
    // revalidate will be deprecated in the 1.x release
    // because mutate() covers the same use case of revalidate().
    // This remains only for backward compatibility
    revalidate: {
      get: () => swr.revalidate,
      enumerable: true
    },
    isValidating: {
      get: () => swr.isValidating,
      enumerable: true
    }
  })
  return (swrInfinite as unknown) as SWRInfiniteResponse<Data, Error>
}

export { useSWRInfinite }
