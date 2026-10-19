@echo off
rem heihua-lab 真实语料全链一键复现(评审限制1的修复: 参数固化)
rem 顺序: 导出语料(只读 messages.db) -^> 八步流水线 -^> LLM 语义判别 -^> 判定结果转候选 -^> 合并 dry-run
rem LLM 判别步需要本机反向代理(127.0.0.1:8790)在线; 不在线时跳过, 前两步产物仍有效。
cd /d %~dp0
set PY="C:/Users/mechrevo/.workbuddy/binaries/python/versions/3.13.12/python.exe"

echo [1/5] 导出语料(只读, 不碰运行中的桥接)
%PY% tools/export_corpus.py || goto :err

echo [2/5] 八步流水线(min-count=2, top-n=500)
%PY% run.py --corpus data/real_corpus.txt --seeds data/seeds.json --out out-real --min-count 2 --top-n 500 || goto :err

echo [3/5] LLM 语义判别(Top40, 需 8790 代理在线)
%PY% tools/llm_judge.py --corpus data/real_corpus.txt --out out-real --top 40 --batch 10
if errorlevel 1 echo [警告] LLM 判别失败(代理不在线?), 沿用上次的 llm_judged.json

echo [4/5] 判别结果转候选(dry-run, 加 --apply 才写)
%PY% tools/judged_to_candidates.py

echo [5/5] 合并 dry-run(默认不写; 确认后加 --apply)
node tools/merge_qq_candidates.mjs --import out-real/qq_candidates.json --slang "E:/workspace/qq-bridge/state/slang.json"
echo.
echo 完成。产物在 out-real/; 要落盘候选请把上一条命令加 --apply。
goto :end

:err
echo 复现链在中途失败, 详见上方输出。
exit /b 1

:end
