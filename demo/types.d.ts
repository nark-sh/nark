// Ambient module declarations so the demo project compiles + scans without
// installing axios, stripe, or @prisma/client. Nark's V2 analyzer reads
// imports and call patterns — it does not need full type coverage of the
// underlying packages to flag missing error handling.

declare module "axios" {
  interface AxiosResponse<T = unknown> {
    data: T;
    status: number;
  }
  interface AxiosInstance {
    get<T = unknown>(url: string, config?: unknown): Promise<AxiosResponse<T>>;
    post<T = unknown>(
      url: string,
      data?: unknown,
      config?: unknown,
    ): Promise<AxiosResponse<T>>;
  }
  const axios: AxiosInstance;
  export default axios;
}

declare module "stripe" {
  class Stripe {
    constructor(apiKey: string, config?: unknown);
    charges: {
      create(params: {
        amount: number;
        currency: string;
        source: string;
      }): Promise<{ id: string; status: string }>;
    };
    customers: {
      create(params: { email: string }): Promise<{ id: string }>;
    };
  }
  export default Stripe;
}

declare module "@prisma/client" {
  export class PrismaClient {
    constructor(config?: unknown);
    user: {
      create(args: {
        data: { email: string; name?: string };
      }): Promise<{ id: string; email: string }>;
      findUnique(args: {
        where: { email: string };
      }): Promise<{ id: string; email: string } | null>;
    };
  }
}
