function tokenize(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ');
  const chars = [...normalized.replace(/\s+/g, '')];
  const grams = new Map();
  for (let i = 0; i < chars.length - 1; i += 1) {
    const gram = chars[i] + chars[i + 1];
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  for (const word of normalized.split(/\s+/)) {
    if (word.length > 1) grams.set(`w:${word}`, (grams.get(`w:${word}`) ?? 0) + 1);
  }
  return grams;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  for (const [k, v] of a.entries()) {
    if (b.has(k)) dot += v * b.get(k);
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MemorySystem {
  constructor({ episodes = [], semantic = null, maxWorking = 60 } = {}) {
    this.working = new Map();
    this.episodic = [];
    this.semantic = semantic ?? this.defaultGraph();
    this.maxWorking = maxWorking;
    this.maxEpisodic = 200;
    for (const episode of episodes) this.addEpisode(episode);
  }

  defaultGraph() {
    return {
      nodes: [
        { id: 'product:P-01', label: '明前狮峰龙井', type: 'product' },
        { id: 'product:P-02', label: '凤凰蜜兰单丛', type: 'product' },
        { id: 'product:P-05', label: '春茶三味礼盒', type: 'product' },
        { id: 'rule:no-extreme', label: '禁用极限词', type: 'rule' },
        { id: 'rule:price-floor', label: '价格不得低于底价', type: 'rule' },
        { id: 'rule:health-claim', label: '不得宣称功效', type: 'rule' },
        { id: 'script:story', label: '故事型话术', type: 'script' },
        { id: 'script:param', label: '参数型话术', type: 'script' },
        { id: 'script:compare', label: '对比型话术', type: 'script' },
        { id: 'audience:night', label: '夜间高客单人群', type: 'audience' },
        { id: 'audience:new', label: '新客尝鲜人群', type: 'audience' },
        { id: 'case:night-story', label: '夜间故事型成功案例', type: 'case' },
        { id: 'case:early-push', label: '开场逼单翻车案例', type: 'case' }
      ],
      edges: [
        { from: 'product:P-01', to: 'script:story', relation: '适合' },
        { from: 'product:P-05', to: 'audience:new', relation: '面向' },
        { from: 'product:P-02', to: 'script:param', relation: '适合' },
        { from: 'script:compare', to: 'rule:no-extreme', relation: '受限' },
        { from: 'script:story', to: 'audience:night', relation: '匹配' },
        { from: 'audience:night', to: 'case:night-story', relation: '证据' },
        { from: 'case:early-push', to: 'rule:price-floor', relation: '教训' },
        { from: 'product:P-01', to: 'rule:price-floor', relation: '约束' },
        { from: 'product:P-02', to: 'rule:health-claim', relation: '约束' }
      ]
    };
  }

  pushWorking(agentId, entry) {
    const list = this.working.get(agentId) ?? [];
    list.push({ ...entry, at: Date.now() });
    if (list.length > this.maxWorking) list.splice(0, list.length - this.maxWorking);
    this.working.set(agentId, list);
    return list;
  }

  getWorking(agentId, limit = 8) {
    return (this.working.get(agentId) ?? []).slice(-limit).reverse();
  }

  addEpisode(episode) {
    const record = {
      id: episode.id ?? `EP-${this.episodic.length + 1}`,
      createdAt: episode.createdAt ?? new Date().toISOString(),
      ...episode,
      _tokens: tokenize(`${episode.title ?? ''} ${episode.text ?? ''} ${(episode.tags ?? []).join(' ')}`)
    };
    this.episodic.unshift(record);
    if (this.episodic.length > this.maxEpisodic) this.episodic.pop();
    return record;
  }

  recall(query, limit = 3) {
    const q = tokenize(query);
    const now = Date.now();
    return this.episodic
      .map((ep) => {
        const semanticScore = cosine(q, ep._tokens);
        const ageDays = Math.max(0, (now - new Date(ep.createdAt ?? now).getTime()) / 86400000);
        const recency = 1 / (1 + ageDays / 30);
        return {
          ...this.publicEpisode(ep),
          score: Number((semanticScore * 0.82 + recency * 0.18).toFixed(4))
        };
      })
      .filter((ep) => ep.score > 0.03)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  publicEpisode(ep) {
    const { _tokens, ...rest } = ep;
    return rest;
  }

  semanticQuery(entity) {
    const needle = String(entity ?? '').toLowerCase();
    const nodes = this.semantic.nodes.filter(
      (n) => n.label.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle)
    );
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.semantic.edges.filter((e) => ids.has(e.from) || ids.has(e.to));
    return { nodes, edges };
  }

  snapshot() {
    return {
      working: Object.fromEntries([...this.working.entries()].map(([k, v]) => [k, v.slice(-4).reverse()])),
      episodicCount: this.episodic.length,
      recentEpisodes: this.episodic.slice(0, 5).map((e) => this.publicEpisode(e)),
      graph: {
        nodes: this.semantic.nodes.length,
        edges: this.semantic.edges.length,
        sample: this.semantic.nodes.slice(0, 7)
      }
    };
  }
}
