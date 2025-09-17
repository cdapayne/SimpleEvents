declare module 'mysql2/promise' {
  export interface PoolOptions {
    [key: string]: any;
  }

  export interface RowDataPacket {
    [column: string]: any;
  }

  export interface ResultSetHeader {
    affectedRows: number;
    insertId: number;
    warningStatus: number;
  }

  export interface Pool {
    query<T = RowDataPacket[]>(sql: string, values?: any[]): Promise<[T, any]>;
    query<T = RowDataPacket[]>(options: any, values?: any[]): Promise<[T, any]>;
    end(): Promise<void>;
  }

  export function createPool(options: PoolOptions): Pool;

  const mysql: {
    createPool: typeof createPool;
  };

  export default mysql;
}
