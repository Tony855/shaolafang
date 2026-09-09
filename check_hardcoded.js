const fs = require('fs');
const path = require('path');

const htmlFiles = ['index.html', 'admin.html', 'waiter.html', 'kitchen.html', 'login.html'];

// 中文字符正则
const chineseRegex = /[\u4e00-\u9fa5]/g;

console.log('=== HTML 文件中硬编码中文检查 ===\n');

htmlFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  
  const hardcodedChinese = [];
  
  lines.forEach((line, index) => {
    // 跳过注释行
    if (line.trim().startsWith('<!--') || line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    // 跳过 script 中的中文字符串（可能是翻译值）
    // 但要检查 HTML 标签中的文本
    
    // 检查 HTML 标签之间的文本
    // 简单方法：查找 >中文< 模式
    const tagTextMatch = line.match(/>([^<]*[\u4e00-\u9fa5][^<]*)</g);
    if (tagTextMatch) {
      tagTextMatch.forEach(match => {
        const text = match.slice(1, -1).trim();
        if (text && chineseRegex.test(text)) {
          // 排除一些常见的非翻译内容
          if (!text.includes('烧腊坊') && !text.includes('admin123')) {
            hardcodedChinese.push({ line: index + 1, text: text.substring(0, 50) });
          }
        }
      });
    }
    
    // 检查 placeholder 和 title 属性中的中文
    const attrMatch = line.match(/(placeholder|title|alt)="([^"]*[\u4e00-\u9fa5][^"]*)"/g);
    if (attrMatch) {
      attrMatch.forEach(match => {
        hardcodedChinese.push({ line: index + 1, text: match.substring(0, 60) });
      });
    }
  });
  
  if (hardcodedChinese.length > 0) {
    console.log(`\n${file}: 发现 ${hardcodedChinese.length} 处硬编码中文`);
    hardcodedChinese.slice(0, 20).forEach(item => {
      console.log(`  行${item.line}: ${item.text}`);
    });
    if (hardcodedChinese.length > 20) {
      console.log(`  ... 还有 ${hardcodedChinese.length - 20} 处`);
    }
  } else {
    console.log(`${file}: ✓ 没有硬编码中文`);
  }
});
