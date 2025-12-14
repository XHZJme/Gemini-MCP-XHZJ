#!/usr/bin/env node
/**
 * Gemini MCP Server - 符合MCP标准协议的Gemini CLI封装
 *
 * 参考官方Python实现(geminimcp)的调用方式：
 * - 使用 `gemini --prompt X -o stream-json` 获取JSON流式输出
 * - 支持 `--resume SESSION_ID` 恢复会话
 * - 解析JSON输出提取session_id和agent_messages
 *
 * 增强功能：
 * - 启动时检查 Gemini CLI 安装状态
 * - 启动时检查认证状态
 * - 配额用尽时的反馈和处理
 *
 * 作者：老金
 */

const { spawn, execSync } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ========== 配置 ==========

// 加载根目录配置文件
const CONFIG_FILE = path.join(__dirname, "..", "..", "mcp-config.json");
var CONFIG = {
  proxy: { enabled: true, http: "http://127.0.0.1:15236", https: "http://127.0.0.1:15236" },
  gemini: { command: "gemini", defaultArgs: ["-o", "stream-json", "--yolo"], timeout: 300000, environment: { GEMINI_IDE_INTEGRATION: "false" } },
  windows: { forceUserprofileAsHome: true, preferCmdExtension: true },
  logging: { enabled: true, level: "INFO" }
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    // Log successful config load after log function is defined
    setTimeout(() => log("配置文件加载成功: " + CONFIG_FILE), 0);
  } catch (e) {
    // Log config parse error - use console.error since log() may not be ready
    console.error("[WARN] 配置文件解析失败: " + CONFIG_FILE + ", 错误: " + e.message + ", 使用默认配置");
  }
} else {
  // Config file not found, using defaults
  console.error("[INFO] 配置文件不存在: " + CONFIG_FILE + ", 使用默认配置");
}

const CONTEXT_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".mcp-context",
  "gemini"
);

if (!fs.existsSync(CONTEXT_DIR)) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
}

const LOG_FILE = path.join(CONTEXT_DIR, "mcp-server.log");

// ========== 状态管理 ==========

var SERVER_STATUS = {
  geminiInstalled: false,
  geminiVersion: null,
  authenticated: false,
  authType: null,
  quotaExhausted: false,
  lastQuotaError: null,
  callCount: 0,
  lastCallTime: null
};

// ========== 工具函数 ==========

function log(message, level) {
  level = level || "INFO";
  var timestamp = new Date().toISOString();
  var logMessage = "[" + timestamp + "] [" + level + "] " + message + "\n";
  fs.appendFileSync(LOG_FILE, logMessage);
}

/**
 * 检查 Gemini CLI 是否已安装
 * 使用多种方式检测，提高 Windows 兼容性
 */
function checkGeminiInstalled() {
  // 方法1: 检查 npm 全局安装目录是否存在 gemini
  var npmGlobalPath = path.join(process.env.APPDATA || "", "npm", "node_modules", "@google", "gemini-cli");
  if (fs.existsSync(npmGlobalPath)) {
    SERVER_STATUS.geminiInstalled = true;
    log("Gemini CLI 已安装 (通过目录检测)");
    
    // 尝试获取版本号
    try {
      var pkgPath = path.join(npmGlobalPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        var pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        SERVER_STATUS.geminiVersion = pkg.version || "unknown";
        log("Gemini CLI 版本: " + SERVER_STATUS.geminiVersion);
      }
    } catch (e) {
      SERVER_STATUS.geminiVersion = "unknown";
    }
    
    return { installed: true, version: SERVER_STATUS.geminiVersion };
  }
  
  // 方法2: 尝试执行命令
  try {
    var result = execSync("gemini --version", { 
      encoding: "utf8", 
      timeout: 10000,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    SERVER_STATUS.geminiInstalled = true;
    SERVER_STATUS.geminiVersion = result.trim();
    log("Gemini CLI 已安装, 版本: " + SERVER_STATUS.geminiVersion);
    return { installed: true, version: SERVER_STATUS.geminiVersion };
  } catch (e) {
    SERVER_STATUS.geminiInstalled = false;
    log("Gemini CLI 未安装或无法访问: " + e.message, "WARN");
    return { 
      installed: false, 
      error: "Gemini CLI 未安装。请运行: npm install -g @google/gemini-cli",
      installCommand: "npm install -g @google/gemini-cli"
    };
  }
}

/**
 * 检查 Gemini 认证状态
 */
function checkAuthStatus() {
  var homeDir = process.env.HOME || process.env.USERPROFILE;
  var geminiDir = path.join(homeDir, ".gemini");
  var settingsFile = path.join(geminiDir, "settings.json");
  var oauthCredsFile = path.join(geminiDir, "oauth_creds.json");
  
  var result = {
    authenticated: false,
    authType: null,
    message: null,
    needsLogin: false,
    loginScript: path.join(__dirname, "..", "..", "gemini_login.bat")
  };
  
  // 检查 API Key 环境变量
  if (process.env.GEMINI_API_KEY) {
    result.authenticated = true;
    result.authType = "api-key";
    result.message = "使用 API Key 认证";
    SERVER_STATUS.authenticated = true;
    SERVER_STATUS.authType = "api-key";
    log("认证状态: 使用 API Key");
    return result;
  }
  
  // 检查 OAuth 凭证文件
  if (fs.existsSync(oauthCredsFile)) {
    try {
      var creds = JSON.parse(fs.readFileSync(oauthCredsFile, "utf8"));
      if (creds.access_token && creds.refresh_token) {
        // 检查是否过期（预留5分钟缓冲）
        var now = Date.now();
        var expiryDate = creds.expiry_date || 0;
        if (expiryDate > now + 300000) {
          result.authenticated = true;
          result.authType = "oauth";
          result.message = "使用 Google 账号认证 (OAuth)";
          SERVER_STATUS.authenticated = true;
          SERVER_STATUS.authType = "oauth";
          log("认证状态: OAuth 有效");
          return result;
        } else if (creds.refresh_token) {
          // 有 refresh_token，可以自动刷新
          result.authenticated = true;
          result.authType = "oauth";
          result.message = "使用 Google 账号认证 (OAuth, 需要刷新)";
          SERVER_STATUS.authenticated = true;
          SERVER_STATUS.authType = "oauth";
          log("认证状态: OAuth 需要刷新，但有 refresh_token");
          return result;
        }
      }
    } catch (e) {
      log("读取 OAuth 凭证失败: " + e.message, "WARN");
    }
  }
  
  // 未认证
  result.authenticated = false;
  result.needsLogin = true;
  result.message = "未认证。请运行 gemini_login.bat 完成 Google 账号登录，获取每天 1000 次免费调用额度。";
  SERVER_STATUS.authenticated = false;
  log("认证状态: 未认证", "WARN");
  return result;
}

/**
 * 检查是否是配额用尽错误
 */
function isQuotaExhaustedError(errorMessage) {
  var quotaKeywords = [
    "quota",
    "rate limit",
    "too many requests",
    "429",
    "exceeded",
    "limit reached",
    "daily limit"
  ];
  var lowerError = (errorMessage || "").toLowerCase();
  for (var i = 0; i < quotaKeywords.length; i++) {
    if (lowerError.indexOf(quotaKeywords[i]) !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * 处理配额用尽情况
 */
function handleQuotaExhausted(errorMessage) {
  SERVER_STATUS.quotaExhausted = true;
  SERVER_STATUS.lastQuotaError = new Date().toISOString();
  log("配额已用尽: " + errorMessage, "WARN");
  
  return {
    success: false,
    quotaExhausted: true,
    message: "⚠️ Gemini 免费配额已用尽！\n\n" +
      "解决方案：\n" +
      "1. 等待明天配额重置（每天 1000 次免费调用）\n" +
      "2. 切换到其他 Google 账号：运行 gemini_login.bat 重新登录\n" +
      "3. 使用 API Key 方式（需要付费）\n\n" +
      "当前时间: " + new Date().toLocaleString("zh-CN"),
    switchAccountScript: path.join(__dirname, "..", "..", "gemini_login.bat")
  };
}

/**
 * Windows下解析CLI命令路径
 * 优先返回.cmd/.bat/.exe文件
 */
function resolveCliCommand(command) {
  if (process.platform === "win32") {
    try {
      var result = execSync("where " + command, { encoding: "utf8" });
      var paths = result.trim().split(/\r?\n/);

      // 优先选择.cmd/.bat/.exe文件
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i].trim();
        if (p.endsWith(".cmd") || p.endsWith(".bat") || p.endsWith(".exe")) {
          return p;
        }
      }

      // 如果没有找到，返回第一个
      if (paths.length > 0) {
        return paths[0].trim();
      }
    } catch (e) {
      log("where命令执行失败: " + e.message, "WARN");
    }
  }
  return command;
}

/**
 * Windows下转义特殊字符
 * 参考官方Python实现的windows_escape函数
 */
function windowsEscape(prompt) {
  if (process.platform !== "win32") {
    return prompt;
  }

  var result = prompt;
  result = result.replace(/\\/g, "\\\\");
  result = result.replace(/"/g, '\\"');
  result = result.replace(/\n/g, "\\n");
  result = result.replace(/\r/g, "\\r");
  result = result.replace(/\t/g, "\\t");
  result = result.replace(/'/g, "\\'");

  return result;
}

/**
 * 调用Gemini CLI
 *
 * Gemini CLI v0.19+ 用法：
 * gemini "prompt" -o stream-json
 * gemini "prompt" -o stream-json --resume <session>
 *
 * 注意：--prompt 参数已废弃，使用位置参数
 */
function callGemini(prompt, options) {
  options = options || {};

  return new Promise(function(resolve, reject) {
    log("调用Gemini CLI, 提示词长度: " + prompt.length);

    var geminiPath = resolveCliCommand("gemini");
    log("Gemini CLI路径: " + geminiPath);

    // 构建命令参数（使用位置参数，--prompt已废弃）
    // Windows shell: true 时需要用引号包裹含空格/中文的参数
    var escapedPrompt = windowsEscape(prompt);
    var quotedPrompt = process.platform === "win32" ? '"' + escapedPrompt + '"' : escapedPrompt;
    var defaultArgs = CONFIG.gemini.defaultArgs || ["-o", "stream-json", "--yolo"];
    var args = [quotedPrompt].concat(defaultArgs);

    if (options.sandbox) {
      args.push("--sandbox");
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }

    log("执行命令: gemini " + args.slice(0, 3).join(" ") + "...");

    // 构建环境变量，确保Windows路径正确
    var spawnEnv = Object.assign({}, process.env);

    // Windows下强制使用USERPROFILE作为HOME，解决Git Bash路径问题
    if (process.platform === "win32" && process.env.USERPROFILE && CONFIG.windows.forceUserprofileAsHome) {
      spawnEnv.HOME = process.env.USERPROFILE;
      log("强制HOME=" + spawnEnv.HOME);
    }

    // 应用gemini特定的环境变量
    var geminiEnv = CONFIG.gemini.environment || {};
    for (var key in geminiEnv) {
      spawnEnv[key] = geminiEnv[key];
    }

    // 代理配置（从配置文件或环境变量）
    if (CONFIG.proxy.enabled) {
      var proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || CONFIG.proxy.https;
      spawnEnv.HTTPS_PROXY = proxy;
      spawnEnv.HTTP_PROXY = process.env.HTTP_PROXY || CONFIG.proxy.http;
      log("代理配置: " + proxy);
    }

    // 如果有API Key，确保传递（支持无浏览器认证）
    if (process.env.GEMINI_API_KEY) {
      log("使用GEMINI_API_KEY认证");
    }

    // Windows下.cmd文件需要shell: true
    var gemini = spawn(geminiPath, args, {
      env: spawnEnv,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    var allMessages = [];
    var agentMessages = "";
    var sessionId = null;
    var errorOutput = "";

    gemini.stdout.on("data", function(data) {
      var lines = data.toString().split("\n");

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        try {
          var lineDict = JSON.parse(line);
          allMessages.push(lineDict);

          // 提取session_id
          if (lineDict.session_id) {
            sessionId = lineDict.session_id;
          }

          // 提取agent消息
          var itemType = lineDict.type || "";
          var itemRole = lineDict.role || "";

          if (itemType === "message" && itemRole === "assistant") {
            var content = lineDict.content || "";
            // 过滤掉deprecation警告
            if (content.indexOf("--prompt (-p) flag has been deprecated") === -1) {
              agentMessages += content;
            }
          }
        } catch (e) {
          // 非JSON行，可能是普通输出
          if (line && line.indexOf("ERROR") === -1) {
            agentMessages += line + "\n";
          }
        }
      }
    });

    gemini.stderr.on("data", function(data) {
      errorOutput += data.toString();
    });

    gemini.on("close", function(code) {
      log("Gemini CLI退出, 退出码: " + code);

      if (code !== 0 && !agentMessages) {
        log("Gemini CLI执行失败: " + errorOutput, "ERROR");
        reject(new Error("Gemini执行失败: " + (errorOutput || "未知错误")));
        return;
      }

      resolve({
        success: true,
        sessionId: sessionId,
        agentMessages: agentMessages,
        allMessages: allMessages
      });
    });

    gemini.on("error", function(error) {
      log("Gemini CLI启动失败: " + error.message, "ERROR");
      reject(new Error("无法启动Gemini CLI: " + error.message));
    });
  });
}

// ========== MCP协议处理 ==========

var TOOLS = [
  {
    name: "gemini",
    description: "调用Google Gemini进行代码审查、UI设计、技术问答。支持SESSION_ID保持多轮对话上下文。Gemini擅长前端设计和UI/UX，但上下文长度有限(32k)。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "给Gemini的提示词"
        },
        SESSION_ID: {
          type: "string",
          description: "可选的会话ID，用于恢复之前的对话上下文"
        },
        model: {
          type: "string",
          description: "可选的模型名称"
        },
        sandbox: {
          type: "boolean",
          description: "是否启用沙箱模式"
        },
        return_all_messages: {
          type: "boolean",
          description: "是否返回所有消息（包括推理过程）"
        }
      },
      required: ["prompt"]
    }
  },
  {
    name: "gemini_status",
    description: "检查 Gemini MCP 服务状态，包括：安装状态、认证状态、配额状态。如果未安装或未认证，会返回相应的解决方案。",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "gemini_reauth",
    description: "重新进行 Gemini 认证。当配额用尽需要切换账号，或认证过期时使用。会返回登录脚本路径。",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "重新认证的原因（可选）"
        }
      },
      required: []
    }
  }
];

function handleToolsList(id) {
  log("处理tools/list请求");
  return {
    jsonrpc: "2.0",
    id: id,
    result: { tools: TOOLS }
  };
}

/**
 * 处理状态检查请求
 */
function handleStatusCheck(id) {
  log("处理 gemini_status 请求");
  
  var installStatus = checkGeminiInstalled();
  var authStatus = checkAuthStatus();
  
  var statusMessage = "=== Gemini MCP 服务状态 ===\n\n";
  
  // 安装状态
  statusMessage += "📦 安装状态: ";
  if (installStatus.installed) {
    statusMessage += "✅ 已安装 (版本: " + installStatus.version + ")\n";
  } else {
    statusMessage += "❌ 未安装\n";
    statusMessage += "   安装命令: " + installStatus.installCommand + "\n";
  }
  
  // 认证状态
  statusMessage += "\n🔐 认证状态: ";
  if (authStatus.authenticated) {
    statusMessage += "✅ " + authStatus.message + "\n";
  } else {
    statusMessage += "❌ " + authStatus.message + "\n";
    if (authStatus.needsLogin) {
      statusMessage += "   登录脚本: " + authStatus.loginScript + "\n";
    }
  }
  
  // 配额状态
  statusMessage += "\n📊 配额状态: ";
  if (SERVER_STATUS.quotaExhausted) {
    statusMessage += "⚠️ 配额已用尽 (上次错误: " + SERVER_STATUS.lastQuotaError + ")\n";
    statusMessage += "   解决方案: 等待明天重置或切换账号\n";
  } else {
    statusMessage += "✅ 正常\n";
  }
  
  // 调用统计
  statusMessage += "\n📈 本次会话调用次数: " + SERVER_STATUS.callCount + "\n";
  if (SERVER_STATUS.lastCallTime) {
    statusMessage += "   最后调用时间: " + SERVER_STATUS.lastCallTime + "\n";
  }
  
  return {
    jsonrpc: "2.0",
    id: id,
    result: {
      content: [{ type: "text", text: statusMessage }],
      status: {
        installed: installStatus.installed,
        version: installStatus.version,
        authenticated: authStatus.authenticated,
        authType: authStatus.authType,
        quotaExhausted: SERVER_STATUS.quotaExhausted,
        callCount: SERVER_STATUS.callCount
      }
    }
  };
}

/**
 * 处理重新认证请求
 */
function handleReauth(id, params) {
  log("处理 gemini_reauth 请求, 原因: " + (params.reason || "用户请求"));
  
  var loginScript = path.join(__dirname, "..", "..", "gemini_login.bat");
  
  // 重置配额状态
  SERVER_STATUS.quotaExhausted = false;
  SERVER_STATUS.lastQuotaError = null;
  
  var message = "🔄 重新认证 Gemini\n\n";
  message += "请按以下步骤操作：\n\n";
  message += "1. 双击运行登录脚本:\n";
  message += "   " + loginScript + "\n\n";
  message += "2. 在弹出的 Gemini CLI 界面中，选择 'Login with Google'\n\n";
  message += "3. 浏览器会自动打开，用 Google 账号登录\n\n";
  message += "4. 登录成功后，重启 Windsurf 即可使用\n\n";
  message += "💡 提示：每个 Google 账号每天有 1000 次免费调用额度";
  
  return {
    jsonrpc: "2.0",
    id: id,
    result: {
      content: [{ type: "text", text: message }],
      loginScript: loginScript,
      quotaReset: true
    }
  };
}

async function handleToolsCall(id, params) {
  var name = params.name;
  var args = params.arguments || {};

  log("处理tools/call请求: " + name);

  // 处理状态检查工具
  if (name === "gemini_status") {
    return handleStatusCheck(id);
  }
  
  // 处理重新认证工具
  if (name === "gemini_reauth") {
    return handleReauth(id, args);
  }

  // 处理 gemini 主工具
  if (name !== "gemini") {
    return {
      jsonrpc: "2.0",
      id: id,
      error: { code: -32601, message: "Unknown tool: " + name }
    };
  }

  if (!args.prompt) {
    return {
      jsonrpc: "2.0",
      id: id,
      error: { code: -32602, message: "Invalid params: prompt is required" }
    };
  }

  // 检查安装状态（使用改进的检测方式）
  if (!SERVER_STATUS.geminiInstalled) {
    var installCheck = checkGeminiInstalled();
    if (!installCheck.installed) {
      // 安装检测失败时，尝试直接调用，让实际错误来判断
      log("安装检测失败，将尝试直接调用 Gemini CLI", "WARN");
    }
  }

  // 检查认证状态
  if (!SERVER_STATUS.authenticated) {
    var authCheck = checkAuthStatus();
    if (!authCheck.authenticated) {
      return {
        jsonrpc: "2.0",
        id: id,
        result: {
          content: [{ 
            type: "text", 
            text: "❌ Gemini 未认证\n\n" +
              authCheck.message + "\n\n" +
              "登录脚本: " + authCheck.loginScript
          }],
          success: false,
          needsAuth: true,
          loginScript: authCheck.loginScript
        }
      };
    }
  }

  try {
    // 更新调用统计
    SERVER_STATUS.callCount++;
    SERVER_STATUS.lastCallTime = new Date().toLocaleString("zh-CN");
    
    var result = await callGemini(args.prompt, {
      sessionId: args.SESSION_ID,
      model: args.model,
      sandbox: args.sandbox
    });

    // 重置配额状态（调用成功说明配额正常）
    SERVER_STATUS.quotaExhausted = false;

    var response = {
      jsonrpc: "2.0",
      id: id,
      result: {
        content: [{ type: "text", text: result.agentMessages }],
        success: true,
        SESSION_ID: result.sessionId
      }
    };

    if (args.return_all_messages) {
      response.result.all_messages = result.allMessages;
    }

    return response;

  } catch (error) {
    log("工具调用失败: " + error.message, "ERROR");
    
    // 检查是否是配额用尽错误
    if (isQuotaExhaustedError(error.message)) {
      var quotaResult = handleQuotaExhausted(error.message);
      return {
        jsonrpc: "2.0",
        id: id,
        result: {
          content: [{ type: "text", text: quotaResult.message }],
          success: false,
          quotaExhausted: true,
          switchAccountScript: quotaResult.switchAccountScript
        }
      };
    }
    
    return {
      jsonrpc: "2.0",
      id: id,
      error: { code: -32603, message: error.message }
    };
  }
}

/**
 * 处理MCP initialize握手请求
 * MCP 2025-06-18协议要求Server响应initialize请求
 */
function handleInitialize(id, params) {
  log("处理initialize请求, 协议版本: " + (params.protocolVersion || "unknown"));
  return {
    jsonrpc: "2.0",
    id: id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "Gemini_MCP_XHZJ",
        version: "1.0.0"
      }
    }
  };
}

async function handleRequest(request) {
  // 处理通知（无需响应）
  if (request.method === "notifications/initialized") {
    log("收到initialized通知");
    return null; // 通知不需要响应
  }

  if (request.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32600, message: "Invalid Request" }
    };
  }

  switch (request.method) {
    case "initialize":
      return handleInitialize(request.id, request.params || {});
    case "tools/list":
      return handleToolsList(request.id);
    case "tools/call":
      return await handleToolsCall(request.id, request.params);
    default:
      log("未知方法: " + request.method, "WARN");
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found: " + request.method }
      };
  }
}

// ========== 主程序 ==========

log("Gemini MCP Server 启动");

// 启动时检查状态
log("正在检查 Gemini CLI 安装状态...");
var startupInstallCheck = checkGeminiInstalled();
if (startupInstallCheck.installed) {
  log("✓ Gemini CLI 已安装: " + startupInstallCheck.version);
} else {
  log("✗ Gemini CLI 未安装", "WARN");
}

log("正在检查认证状态...");
var startupAuthCheck = checkAuthStatus();
if (startupAuthCheck.authenticated) {
  log("✓ 认证状态: " + startupAuthCheck.message);
} else {
  log("✗ " + startupAuthCheck.message, "WARN");
}

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on("line", async function(line) {
  try {
    log("收到请求: " + line.substring(0, 100) + "...");
    var request = JSON.parse(line);
    var response = await handleRequest(request);
    // 通知类请求不需要响应
    if (response !== null) {
      console.log(JSON.stringify(response));
      log("响应已发送");
    } else {
      log("通知已处理（无需响应）");
    }
  } catch (error) {
    log("处理请求失败: " + error.message, "ERROR");
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: " + error.message }
    }));
  }
});

process.on("SIGINT", function() {
  log("收到SIGINT信号，正在关闭...");
  rl.close();
  process.exit(0);
});

process.on("SIGTERM", function() {
  log("收到SIGTERM信号，正在关闭...");
  rl.close();
  process.exit(0);
});

log("Gemini MCP Server 已就绪，等待请求...");
