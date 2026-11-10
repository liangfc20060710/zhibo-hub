const SOFT_REPLACEMENTS = [
  ['全网最低价', '本场专属价'],
  ['全网最低', '本场专属价'],
  ['最便宜', '很有竞争力的价格'],
  ['100%有效', '体验因人而异'],
  ['绝对有效', '体验因人而异'],
  ['绝对', '相对'],
  ['根治', '日常品饮'],
  ['治疗', '日常品饮'],
  ['降血糖', '日常品饮'],
  ['降血压', '日常品饮'],
  ['无副作用', '个体感受不同'],
  ['永久', '长期'],
  ['国家级', '具备资质'],
  ['秒杀全网', '本场限时']
];

export class Guardrails {
  constructor({ config, products = [] }) {
    this.config = config;
    this.products = products;
    this.vetoes = [];
  }

  inspectScript(text, { product = null } = {}) {
    const source = String(text ?? '');
    const violations = [];
    for (const word of this.config.bannedWords) {
      if (source.includes(word)) {
        violations.push({ type: 'banned_word', term: word, message: `命中违禁/极限词「${word}」` });
      }
    }

    const priceMatches = [...source.matchAll(/(\d{2,5})\s*元/g)].map((m) => Number(m[1]));
    if (product) {
      for (const price of priceMatches) {
        if (price < product.floor) {
          violations.push({
            type: 'price_floor',
            term: String(price),
            message: `口播价格 ¥${price} 低于 ${product.name} 底价 ¥${product.floor}`
          });
        }
      }
      const inventoryMatch = source.match(/库存\s*(\d+)/);
      if (inventoryMatch && Number(inventoryMatch[1]) > product.stock * 1.25) {
        violations.push({
          type: 'inventory_claim',
          term: inventoryMatch[1],
          message: `口播库存 ${inventoryMatch[1]} 高于工具返回值 ${product.stock}`
        });
      }
    }

    let rewritten = source;
    for (const [term, replacement] of SOFT_REPLACEMENTS) {
      rewritten = rewritten.split(term).join(replacement);
    }
    const requiresDisclaimer = /(体感|功效|养生|睡眠|血糖|血压)/.test(source);
    if (requiresDisclaimer && !rewritten.includes(this.config.requireDisclaimer)) {
      rewritten = `${rewritten}（${this.config.requireDisclaimer}）`;
    }

    return {
      pass: violations.length === 0,
      violations,
      rewritten,
      requiresDisclaimer,
      risk: violations.some((v) => v.type === 'price_floor' || v.type === 'banned_word') ? 'high' : 'low'
    };
  }

  checkPrice(product, price) {
    if (!product) return { pass: false, reason: '商品不存在' };
    if (price < product.floor) {
      return {
        pass: false,
        reason: `出价 ¥${price} 低于底价 ¥${product.floor}，触发价格红线`,
        code: 'PRICE_FLOOR'
      };
    }
    const discount = 1 - price / product.price;
    if (discount > this.config.maxDiscount + 0.0001) {
      return {
        pass: false,
        reason: `折扣 ${(discount * 100).toFixed(1)}% 超过单场上限 ${(this.config.maxDiscount * 100).toFixed(0)}%`,
        code: 'MAX_DISCOUNT'
      };
    }
    return { pass: true, discount };
  }

  complianceVeto(proposal) {
    const action = String(proposal.action ?? '');
    const evidence = proposal.evidence ?? [];

    const priceMatch = action.match(/(\d{3,5})\s*元/);
    if (proposal.productId) {
      const product = this.products.find((p) => p.id === proposal.productId);
      const targetPrice = proposal.newPrice ?? (priceMatch ? Number(priceMatch[1]) : null);
      if (targetPrice != null) {
        const priceCheck = this.checkPrice(product, targetPrice);
        if (!priceCheck.pass) {
          const veto = {
            code: priceCheck.code,
            reason: priceCheck.reason,
            severity: 'critical',
            at: Date.now()
          };
          this.vetoes.unshift(veto);
          return { vetoed: true, ...veto };
        }
      }
    }

    if (proposal.script) {
      const inspection = this.inspectScript(proposal.script, { product: proposal.product });
      if (!inspection.pass) {
        const veto = {
          code: 'SCRIPT_VIOLATION',
          reason: inspection.violations.map((v) => v.message).join('；'),
          severity: 'high',
          at: Date.now()
        };
        this.vetoes.unshift(veto);
        return { vetoed: true, ...veto };
      }
    }

    if (proposal.risk === 'high' && evidence.length === 0) {
      const veto = {
        code: 'NO_EVIDENCE',
        reason: '高风险动作缺少可核验证据，合规要求补充后再表决',
        severity: 'high',
        at: Date.now()
      };
      this.vetoes.unshift(veto);
      return { vetoed: true, ...veto };
    }

    return { vetoed: false };
  }

  snapshot() {
    return {
      bannedWords: this.config.bannedWords,
      priceFloorRatio: this.config.priceFloorRatio,
      maxDiscount: this.config.maxDiscount,
      vetoes: this.vetoes.slice(0, 6)
    };
  }
}
