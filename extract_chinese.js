const fs = require('fs');

const htmlFiles = ['index.html', 'admin.html', 'waiter.html', 'kitchen.html', 'login.html'];
const chineseRegex = /[\u4e00-\u9fa5]/g;

const allTexts = new Set();

htmlFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    // 检查 HTML 标签之间的文本
    const tagTextMatch = line.match(/>([^<]*[\u4e00-\u9fa5][^<]*)</g);
    if (tagTextMatch) {
      tagTextMatch.forEach(match => {
        const text = match.slice(1, -1).trim();
        if (text && chineseRegex.test(text) && text.length < 50) {
          // 清理 emoji 和特殊字符
          const cleanText = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '').trim();
          if (cleanText && cleanText.length > 1) {
            allTexts.add(cleanText);
          }
        }
      });
    }
    
    // 检查 placeholder 和 title 属性
    const attrMatch = line.match(/(placeholder|title|alt)="([^"]*[\u4e00-\u9fa5][^"]*)"/g);
    if (attrMatch) {
      attrMatch.forEach(match => {
        const text = match.match(/"([^"]*)"/)[1];
        if (text && chineseRegex.test(text)) {
          allTexts.add(text);
        }
      });
    }
  });
});

console.log(`=== 唯一硬编码中文文本（共 ${allTexts.size} 个）===\n`);
const sorted = [...allTexts].sort();
sorted.forEach((text, i) => {
  console.log(`${i + 1}. ${text}`);
});
