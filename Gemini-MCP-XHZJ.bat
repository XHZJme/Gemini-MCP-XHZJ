@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo    Gemini-MCP-XHZJ - 管理工具
echo ========================================
echo.
echo 请选择操作:
echo.
echo   [1] 检查状态 - 查看安装和认证状态
echo   [2] 登录认证 - 用 Google 账号登录
echo   [3] 切换账号 - 配额用完时切换
echo   [4] 退出
echo.
echo ========================================
echo.

set /p choice="请输入选项 (1-4): "

if "%choice%"=="1" goto check_status
if "%choice%"=="2" goto login
if "%choice%"=="3" goto switch_account
if "%choice%"=="4" goto exit
goto invalid

:check_status
echo.
echo ========================================
echo 正在检查状态...
echo ========================================
echo.

REM 检查 Gemini CLI 安装
where gemini >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Gemini CLI: 未安装
    echo     安装命令: npm install -g @google/gemini-cli
) else (
    for /f "tokens=*" %%i in ('gemini --version 2^>nul') do set VERSION=%%i
    echo [√] Gemini CLI: 已安装 ^(版本: !VERSION!^)
)

echo.

REM 检查认证状态
if exist "%USERPROFILE%\.gemini\oauth_creds.json" (
    echo [√] 认证状态: 已登录 ^(OAuth^)
) else if defined GEMINI_API_KEY (
    echo [√] 认证状态: 已配置 ^(API Key^)
) else (
    echo [X] 认证状态: 未登录
    echo     请选择选项 2 进行登录
)

echo.
echo ========================================
pause
goto end

:login
echo.
echo ========================================
echo 启动 Gemini 登录...
echo ========================================
echo.
echo 请确保 Clash 代理已开启 (端口 7890)
echo.
echo 启动后:
echo   1. 用方向键选择 "Login with Google"
echo   2. 按 Enter 确认
echo   3. 在浏览器中完成 Google 登录
echo.
echo ========================================
echo.

set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890

gemini

pause
goto end

:switch_account
echo.
echo ========================================
echo 切换 Google 账号
echo ========================================
echo.
echo 将清除当前认证，重新登录...
echo.

REM 删除旧的认证文件
if exist "%USERPROFILE%\.gemini\oauth_creds.json" (
    del "%USERPROFILE%\.gemini\oauth_creds.json" >nul 2>&1
    echo [√] 已清除旧认证
)
if exist "%USERPROFILE%\.gemini\google_accounts.json" (
    del "%USERPROFILE%\.gemini\google_accounts.json" >nul 2>&1
)

echo.
echo 请重新登录...
echo.

set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890

gemini

pause
goto end

:invalid
echo.
echo [!] 无效选项，请输入 1-4
echo.
pause
goto end

:exit
echo.
echo 再见！
echo.
goto end

:end
endlocal
