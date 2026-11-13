import type { ReactNode } from 'react';

export interface TableColumn<T> {
  key: string;
  label: ReactNode;
  width?: number | string;
  /** 数字列（命中、字数、块数、人数）：右对齐 + 等宽数字 */
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: ReactNode;
  /** 表格名，落到 aria-label（「标准答案列表」「资料列表」） */
  label?: string;
  /** fixed 这类特殊行混在表里时加 class */
  rowClassName?: (row: T) => string | undefined;
}

/** 细线表格。空状态放在 tbody 里，保持表头不跳。 */
export default function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  label,
  rowClassName,
}: TableProps<T>) {
  return (
    <div className="scroll">
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? 'num' : undefined}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="table-empty" colSpan={columns.length}>
                {empty ?? '没有'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className={rowClassName?.(row)}>
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'num' : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
