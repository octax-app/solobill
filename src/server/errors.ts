export class ApiError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429
  link?: string

  constructor(status: ApiError['status'], message: string, link?: string) {
    super(message)
    this.status = status
    this.link = link
  }
}

export const notFound = (what: string) => new ApiError(404, `${what} not found`)
