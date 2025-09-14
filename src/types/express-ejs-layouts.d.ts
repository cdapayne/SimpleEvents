declare module 'express-ejs-layouts' {
  import { RequestHandler } from 'express';
  const expressEjsLayouts: RequestHandler & { [key: string]: any };
  export = expressEjsLayouts;
}