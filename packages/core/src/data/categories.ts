import type { Category } from '../types/catalog.js';

export const categories: Category[] = [
  {
    id: 'louvers',
    labelTh: 'ระแนงและป้องกันแสงแดด',
    summaryTh: 'ระแนงปรับองศาได้ และบานทุกชนิดที่ใช้ระแนงแทนกระจก',
  },
  {
    id: 'multi',
    labelTh: '2in1 บานมัลติฟังก์ชัน',
    summaryTh: 'บานที่เปลี่ยนวิธีเปิดได้สองแบบในชุดเดียว',
  },
  {
    id: 'folding',
    labelTh: 'บานเฟี้ยม',
    summaryTh: 'พับเก็บได้ทั้งแผง เปิดช่องได้เกือบเต็มความกว้าง',
  },
  {
    id: 'casement',
    labelTh: 'บานเปิด',
    summaryTh: 'ประตูและหน้าต่างบานเปิด รวมบานกระทุ้ง',
  },
  {
    id: 'swing',
    labelTh: 'บานสวิง',
    summaryTh: 'เปิดได้สองทาง เหมาะกับทางเดินที่มีคนผ่านบ่อย',
  },
  {
    id: 'hanging',
    labelTh: 'บานแขวน',
    summaryTh: 'เลื่อนบนรางแขวน ไม่มีรางล่างให้สะดุด',
  },
  {
    id: 'sliding',
    labelTh: 'บานเลื่อน',
    summaryTh: 'ประตูและหน้าต่างบานเลื่อนบนรางคู่',
  },
  {
    id: 'vertical-sliding',
    labelTh: 'บานเลื่อนแนวตั้ง',
    summaryTh: 'เลื่อนขึ้นลง ประหยัดพื้นที่ด้านข้าง',
  },
  {
    id: 'fixed',
    labelTh: 'บานปิดตาย',
    summaryTh: 'ช่องแสงติดตาย เปิดไม่ได้ ใช้รับแสงและกันเสียง',
  },
  {
    id: 'screens',
    labelTh: 'มุ้งกันยุงและแมลง',
    summaryTh: 'มุ้งลวดและมุ้งจีบ ติดคู่กับบานเดิมหรือติดแยก',
  },
];

export const getCategoryById = (id: string): Category | undefined =>
  categories.find((category) => category.id === id);
