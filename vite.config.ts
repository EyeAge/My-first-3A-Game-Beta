import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 打包成和原版 demo 一样的单文件 HTML：JS、CSS 全部内联，零网络请求。
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
