---
courseId: git-and-github
updated: 2026-09-01
---

# Git 与 GitHub 开源实践笔记

## 工作区域

working tree 是正在编辑的文件，staging area 是准备进入下一次提交的变化，repository 是已经提交的历史。

## 远程协作

本地 commit 先保存历史，`git push` 才会把提交发送到远程仓库。`git fetch` 只更新远程跟踪信息，`git pull` 通常还会把远程变化整合到当前分支。
