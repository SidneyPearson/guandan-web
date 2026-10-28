/* Per-seat voice preferences and honest installed-pack routing. No network TTS. */
(function(){
  const root=typeof window!=='undefined'?window:self,GD=root.GD=root.GD||{};
  const languages=Object.freeze([
    {id:'mandarin',name:'普通话'},{id:'sichuan',name:'四川话'},{id:'shanghai',name:'沪语'},
    {id:'yangzhou',name:'扬州话'},{id:'funing',name:'盐城阜宁话'},{id:'cantonese',name:'粤语'},
    {id:'henan',name:'河南话'},{id:'dongbei',name:'东北话'},
  ].map(Object.freeze));
  const languageIds=new Set(languages.map(x=>x.id)),genders=new Set(['female','male']);
  const defaults=['female','male','female','male'];
  function normalize(value,legacyStyle){
    return defaults.map((gender,seat)=>{
      const oldGender=legacyStyle==='bright'?'female':legacyStyle==='calm'?'male':gender;
      const v=Array.isArray(value)&&value[seat]&&typeof value[seat]==='object'?value[seat]:{};
      return {language:languageIds.has(v.language)?v.language:'mandarin',gender:genders.has(v.gender)?v.gender:oldGender};
    });
  }
  function resolve(seat,preference){
    if(!Number.isInteger(seat)||seat<0||seat>3)return null;
    const normalized=normalize([0,1,2,3].map(s=>s===seat?preference:null))[seat];
    const {language,gender}=normalized;
    const profile=language==='mandarin'?(gender==='female'?['bright','spark','spark','bright'][seat]:['calm','bold','bold','calm'][seat]):language+'-'+gender;
    const ready=language==='mandarin'||!!GD.VOICE_PACKS?.[profile]?.ready;
    return {...normalized,profile,ready,name:languages.find(x=>x.id===language).name,genderName:gender==='female'?'女声':'男声'};
  }
  function installedProfiles(){return [...(GD.VOICE_PROFILES||[]),...Object.keys(GD.VOICE_PACKS||{}).filter(k=>GD.VOICE_PACKS[k].ready)];}
  GD.voicePreferences={languages,normalize,resolve,installedProfiles};
})();
