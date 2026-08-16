import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

// 构建产物直接复制到 vault 插件目录（路径含空格与中文，用双反斜杠转义）
const vaultPluginDir = "D:\\Obsidian Vault\\Obsidian Vault\\.obsidian\\plugins\\obsidian-dsh";

const prod = process.argv[2] === "production";

console.log("Building obsidian-dsh with esbuild.buildSync...");

try {
	esbuild.buildSync({
		// 入口：src/main.ts，单文件 bundle 输出 main.js
		entryPoints: ["src/main.ts"],
		bundle: true,
		// 运行时由 Obsidian（Electron）提供的模块，全部 external
		external: [
			"obsidian",
			"electron",
			"child_process",
			"fs",
			"path",
			"os",
			"http",
			"https",
			"net",
			"tls",
			"stream",
			"util",
			"events",
			"url",
			"zlib",
			"buffer",
			"crypto"
		],
		format: "cjs",
		platform: "browser",
		target: "es2022",
		logLevel: "info",
		sourcemap: prod ? false : "inline",
		treeShaking: true,
		outfile: "main.js",
		write: true
	});
	console.log("Build main.js success.");

	// 安装：复制 3 个文件到 vault 插件目录
	if (fs.existsSync(vaultPluginDir)) {
		fs.copyFileSync("main.js", path.join(vaultPluginDir, "main.js"));
		fs.copyFileSync("manifest.json", path.join(vaultPluginDir, "manifest.json"));
		fs.copyFileSync("styles.css", path.join(vaultPluginDir, "styles.css"));
		console.log("Successfully copied main.js/manifest.json/styles.css into Obsidian Vault plugin directory!");
	} else {
		console.warn("vault 插件目录不存在，跳过复制:", vaultPluginDir);
	}
} catch (e) {
	console.error("Build failed:", e);
	process.exit(1);
}

process.exit(0);
