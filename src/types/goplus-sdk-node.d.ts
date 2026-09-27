declare module "@goplus/sdk-node" {
  interface GoPlusTokenResult {
    access_token?: string;
    [key: string]: unknown;
  }

  interface GoPlusResponse<T = unknown> {
    code?: number;
    message?: string;
    result?: T;
    [key: string]: unknown;
  }

  interface GoPlusClient {
    config(appKey: string, appSecret: string, timeout?: number): void;
    getAccessToken(): Promise<GoPlusResponse<GoPlusTokenResult>>;
    tokenSecurity(
      chainId: string,
      tokens: string[],
      timeout?: number
    ): Promise<GoPlusResponse<Record<string, Record<string, unknown>>>>;
    rugpullDetection(
      chainId: string,
      contractAddresses: string,
      timeout?: number
    ): Promise<GoPlusResponse<Record<string, unknown>>>;
  }

  const GoPlus: GoPlusClient;
  export default GoPlus;
}
