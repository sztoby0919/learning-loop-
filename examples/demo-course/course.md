---
id: git-and-github
title: Git 与 GitHub 开源实践
shortTitle: Git / GitHub
accent: "#27624B"
updated: 2026-09-01
order: 1
archived: false
---

# Git 与 GitHub 开源实践

## 课程概览

这是一个脱敏示例课程，用来展示 Learning Loop 如何把任意学习主题整理成可追踪、可复习的学习档案。示例内容覆盖 Git 基础、分支协作和 GitHub 项目发布。

## 学习路线

### 基础概念
- [x] 用自己的话解释 repository、commit 和 working tree
- [x] 完成一次本地 commit 并查看变更
- [ ] 解释 staging area 为什么存在

### 协作流程
- [ ] 创建分支并合并一个小改动
- [ ] 解释 pull、fetch 和 merge 的区别
- [ ] 为项目写出清晰的 README 快速开始

### 开源发布
- [ ] 检查仓库中没有个人路径和敏感记录
- [ ] 配置 GitHub Actions 执行测试
- [ ] 从干净目录完成一次 clone 后启动

## 关键知识

### 三个工作区域

Git 用 working tree、staging area 和 repository 记录文件变化。`git add` 把选择的变化放入 staging area，`git commit` 再把这批变化保存到 repository。

### 分支的作用

分支是指向 commit 的可移动引用。它让实验性改动可以与稳定版本并行，合并前可以通过测试和代码审查降低风险。

## 易错点

### 把 Git 和 GitHub 混为一谈

- 问题：把 GitHub 当成 Git 本身，认为没有网络就不能 commit。
- 原因：GitHub 提供远程仓库、协作和 CI，而 Git 是本地版本控制工具。
- 正确理解：本地 commit 不依赖 GitHub；push、pull 和 Actions 才需要远程服务。

## 学习记录

| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
| 2026-08-31 | 区分 Git 本地仓库和 GitHub 远程仓库 | 6 | 容易混淆 push 与 commit | 练习分支合并 |
| 2026-09-01 | 完成一个最小开源仓库的发布检查 | 7 | 忽略本机配置文件 | 添加 GitHub Actions |
