declare module "mammoth" {
  interface ConvertToHtmlResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  interface ExtractRawTextResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  function convertToHtml(input: { buffer?: Buffer }, options?: { styleMap?: string[] }): Promise<ConvertToHtmlResult>;
  function extractRawText(input: { buffer?: Buffer }): Promise<ExtractRawTextResult>;

  export { convertToHtml, extractRawText };
}
