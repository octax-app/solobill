/** Runs async work one at a time. The app is a single process, so this serialises issuing. */
export function createLock() {
  let tail: Promise<unknown> = Promise.resolve()
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task)
    tail = result.catch(() => undefined)
    return result
  }
}
