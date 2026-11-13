import { useEffect, useState, type MouseEventHandler } from 'react';

import { api } from '../api/client';

interface AuthImageProps {
  src: string;
  alt: string;
  className?: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLImageElement>;
}

interface CachedImage {
  refs: number;
  url: string | null;
  promise: Promise<string>;
}

// 同一张图在表格行和编辑弹窗里同时出现只 fetch 一次；最后一个使用者走了才 revoke
const imageCache = new Map<string, CachedImage>();

function acquire(src: string): CachedImage {
  let entry = imageCache.get(src);
  if (!entry) {
    const item: CachedImage = {
      refs: 0,
      url: null,
      promise: Promise.resolve(''),
    };
    item.promise = api
      .getBlob(src)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        item.url = url;
        // 取图期间最后一个使用者已经卸载：别把 blob URL 留在内存里
        if (item.refs <= 0) {
          imageCache.delete(src);
          URL.revokeObjectURL(url);
          item.url = null;
        }
        return url;
      })
      .catch((err: unknown) => {
        if (imageCache.get(src) === item) imageCache.delete(src);
        throw err;
      });
    imageCache.set(src, item);
    entry = item;
  }
  entry.refs += 1;
  return entry;
}

function release(src: string, entry: CachedImage): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  // 请求还在途就先留在 Map 里，等回来时按 refs 判断；已经好了就立刻 revoke
  if (entry.url) {
    imageCache.delete(src);
    URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}

/** <img> 带不了 Authorization，先 fetch 成 blob 再给 URL；同一 src 共用一份。 */
export default function AuthImage({ src, alt, className, title, onClick }: AuthImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);

    const entry = acquire(src);
    entry.promise.then(
      (next) => {
        if (alive) setUrl(next);
      },
      () => {
        if (alive) setFailed(true);
      },
    );

    return () => {
      alive = false;
      release(src, entry);
    };
  }, [src]);

  if (failed) {
    return (
      <span className={className ? `auth-img-fallback ${className}` : 'auth-img-fallback'} aria-label={alt}>
        图没了
      </span>
    );
  }

  if (!url) {
    return (
      <span className={className ? `auth-img-placeholder ${className}` : 'auth-img-placeholder'} aria-label="图片读取中">
        读取中
      </span>
    );
  }

  return <img className={className} src={url} alt={alt} title={title} onClick={onClick} />;
}
