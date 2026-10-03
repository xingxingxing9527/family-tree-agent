import type { PersonListItem } from "../../../../shared/contracts";

export const PENDING_SURNAME_KEY = "__pending_surname__";

export interface SurnameGroup {
  key: string;
  label: string;
  people: PersonListItem[];
}

const COMPOUND_SURNAMES = [
  "欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人",
  "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶",
  "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于",
  "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "壤驷", "公良",
  "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里",
  "呼延", "东郭", "南门", "羊舌", "微生", "梁丘", "左丘", "东门", "西门"
] as const;

// 保守识别常见姓氏；无法可靠判断的名字宁可进入“待确认”，不擅自改写人物数据。
const SINGLE_SURNAMES = new Set([
  ..."赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲台从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公",
  "闫", "校", "亓"
]);

const KINSHIP_DESCRIPTION = /(?:老公|老婆|丈夫|妻子|爱人|父亲|母亲|爸爸|妈妈|爹|娘|爷爷|奶奶|姥爷|姥姥|外公|外婆|祖父|祖母|大伯|伯父|伯母|叔叔|叔父|婶婶|婶子|舅舅|舅妈|姨妈|姨父|姑姑|姑父|哥哥|嫂子|弟弟|弟媳|姐姐|姐夫|妹妹|妹夫)$/;
const PINYIN_COLLATOR = new Intl.Collator("zh-CN-u-co-pinyin");

export function inferSurname(displayName: string): string | null {
  const name = displayName.trim();
  if (!name || !/^[\u3400-\u9fff]+$/.test(name) || KINSHIP_DESCRIPTION.test(name)) return null;

  const compound = COMPOUND_SURNAMES.find((surname) => name.startsWith(surname));
  if (compound) return compound;

  const firstCharacter = Array.from(name)[0];
  return firstCharacter && SINGLE_SURNAMES.has(firstCharacter) ? firstCharacter : null;
}

function comparePeople(left: PersonListItem, right: PersonListItem): number {
  return PINYIN_COLLATOR.compare(left.displayName, right.displayName)
    || PINYIN_COLLATOR.compare(left.personCode, right.personCode)
    || left.id.localeCompare(right.id);
}

export function groupPeopleBySurname(people: PersonListItem[]): SurnameGroup[] {
  const grouped = new Map<string, PersonListItem[]>();
  for (const person of people) {
    const key = inferSurname(person.displayName) ?? PENDING_SURNAME_KEY;
    const group = grouped.get(key) ?? [];
    group.push(person);
    grouped.set(key, group);
  }

  return Array.from(grouped, ([key, entries]) => ({
    key,
    label: key === PENDING_SURNAME_KEY ? `姓氏待确认（${entries.length}人）` : `${key}姓（${entries.length}人）`,
    people: [...entries].sort(comparePeople)
  })).sort((left, right) => {
    if (left.key === PENDING_SURNAME_KEY) return 1;
    if (right.key === PENDING_SURNAME_KEY) return -1;
    return PINYIN_COLLATOR.compare(left.key, right.key);
  });
}
