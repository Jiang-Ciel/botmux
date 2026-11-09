下面重新整理 **MoE 路由、负载均衡和训练稳定性**对应的公式。

## 1. Router 路由概率

设共有 \(E\) 个专家，一个 batch 有 \(M\) 个有效 token，每个 token 选择 \(K\) 个专家。

对于 token 表示 \(x_t\)，Router 计算：

\[
z_t = W_r x_t
\]

\[
p_{t,i}
=
\frac{\exp(z_{t,i})}
{\sum_{j=1}^{E}\exp(z_{t,j})}
\]

其中：
- \(z_{t,i}\)：token \(t\) 对专家 \(i\) 的路由分数。
- \(p_{t,i}\)：对应的路由概率。

选择 Top-K 专家：

\[
S_t = \operatorname{TopK}(p_t, K)
\]

在选中的专家间归一化：

\[
w_{t,i}
=
\frac{p_{t,i}}
{\sum_{j\in S_t}p_{t,j}},
\qquad i\in S_t
\]

MoE 输出：

\[
y_t
=
\sum_{i\in S_t}
w_{t,i}\,F_i(x_t)
\]

其中 \(F_i\) 是第 \(i\) 个专家的 FFN。

> 当 \(K=1\) 时，上述归一化权重恒为 1。为了保留主任务损失到 Router 的权重梯度路径，可以使用原始概率 \(w_{t,i}=p_{t,i}\)，而不进行归一化。

---

## 2. 负载均衡辅助损失

定义分配指示量：

\[
a_{t,i}
=
\begin{cases}
1, & i\in S_t\\
0, & i\notin S_t
\end{cases}
\]

专家 \(i\) 接收的 token 数：

\[
n_i = \sum_{t=1}^{M}a_{t,i}
\]

每个 token 分配给 \(K\) 个专家，因此：

\[
\sum_{i=1}^{E}n_i = MK
\]

### 实际负载比例

\[
f_i
=
\frac{n_i}{MK}
=
\frac{1}{MK}
\sum_{t=1}^{M}a_{t,i}
\]

### 平均路由概率

\[
\bar p_i
=
\frac{1}{M}
\sum_{t=1}^{M}p_{t,i}
\]

两者均满足：

\[
\sum_{i=1}^{E}f_i=1,
\qquad
\sum_{i=1}^{E}\bar p_i=1
\]

### Switch 风格的 Top-K 扩展损失

\[
\boxed{
L_{\mathrm{balance}}
=
E\sum_{i=1}^{E}
\operatorname{stopgrad}(f_i)\,\bar p_i
}
\]

`stopgrad` 表示实际分配统计不参与求导，梯度通过平均路由概率传回 Router。

完全均匀时：

\[
f_i=\bar p_i=\frac{1}{E}
\]

因此：

\[
L_{\mathrm{balance}}=1
\]

**这是软约束，不保证实际分配严格均匀；损失等于 1 也不能单独证明路由均衡。**

---

## 3. Router z-loss

用于稳定 Router 的 softmax 归一化项：

\[
\boxed{
L_z
=
\frac{1}{M}
\sum_{t=1}^{M}
\left(
\log\sum_{i=1}^{E}\exp(z_{t,i})
\right)^2
}
\]

实现时应使用数值稳定的 `logsumexp`，通常以 FP32 计算。

---

## 4. 总训练损失

采用辅助损失均衡时：

\[
\boxed{
L_{\mathrm{total}}
=
L_{\mathrm{task}}
+
\lambda_{\mathrm{balance}}L_{\mathrm{balance}}
+
\lambda_z L_z
}
\]

其中：
- \(L_{\mathrm{task}}\)：语言模型交叉熵等主任务损失。
- \(\lambda_{\mathrm{balance}}\)：均衡约束强度。
- \(\lambda_z\)：路由数值稳定性约束强度。

---

## 5. 负载反馈 bias

这是另一种调节均衡的方法，可替代或配合辅助损失。

令训练 step 为 \(s\)，专家 \(i\) 的反馈偏置为 \(b_i^{(s)}\)。

### 带 bias 的专家选择

\[
q_{t,i}=p_{t,i}+b_i^{(s)}
\]

\[
S_t=\operatorname{TopK}(q_t,K)
\]

**输出混合权重仍使用不含 bias 的原始概率：**

\[
w_{t,i}
=
\frac{p_{t,i}}
{\sum_{j\in S_t}p_{t,j}}
\]

### 按实际负载更新 bias

令该 step 的平均专家负载为：

\[
\bar n^{(s)}
=
\frac{1}{E}\sum_{i=1}^{E}n_i^{(s)}
\]

更新：

\[
\boxed{
\tilde b_i^{(s+1)}
=
b_i^{(s)}
+
\eta_b\,
\operatorname{sign}
\left(
\bar n^{(s)}-n_i^{(s)}
\right)
}
\]

去除公共偏移：

\[
b_i^{(s+1)}
=
\tilde b_i^{(s+1)}
-
\frac{1}{E}
\sum_{j=1}^{E}\tilde b_j^{(s+1)}
\]

含义：
- 欠载专家：bias 增加。
- 过载专家：bias 减少。
- 去除公共偏移不会改变 Top-K 排序。

---

## 6. 专家容量与均衡指标

### 专家容量

\[
\boxed{
C
=
\left\lceil
\alpha_{\mathrm{capacity}}
\frac{MK}{E}
\right\rceil
}
\]

其中 \(\alpha_{\mathrm{capacity}}\) 是容量系数。容量限制只限制过载，并不会自动填满欠载专家。

### 最大负载与平均负载之比

\[
R_{\mathrm{max/mean}}
=
\frac{\max_i n_i}{\bar n}
\]

越接近 1，负载越均衡。

### 负载变异系数

\[
\boxed{
\mathrm{CV}
=
\frac{
\sqrt{
\frac{1}{E}
\sum_{i=1}^{E}(n_i-\bar n)^2
}
}{
\bar n
}
}
\]

当 \(\bar n>0\) 时，CV 越接近 0，负载越均衡。

**总结：任务损失负责学习能力，负载均衡损失或反馈 bias 负责调节专家使用率，z-loss 负责路由数值稳定性。**