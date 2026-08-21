
(function(){
"use strict";

var MONTH_LABELS=["Juillet","Août","Septembre","Octobre","Novembre","Décembre","Janvier","Février","Mars","Avril","Mai","Juin"];

/* ================= STATE ================= */
var state=null;
var currentUser=null;
var authView={mode:"loading",error:""};
var globalSections=null; /* liste des sections (null = pas encore chargée), utilisée par l'administrateur général */
var ui={tab:"dashboard",
  activeSection:null,
  filters:{q:"",type:"",compte:"",cat:"",validOnly:"",from:"",to:""},
  sort:{key:"dateOp",dir:"desc"},
  modal:null,editing:null,confirm:null,users:null};

function escHtml(s){
  if(s===undefined||s===null) return "";
  return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];});
}
function fmtMoney(n){
  n=Number(n)||0;
  var neg=n<0; n=Math.abs(n);
  var s=n.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2});
  return (neg?"-":"")+s+" €";
}
function fmtDate(s){
  if(!s) return "—";
  var p=s.split("-"); if(p.length!==3) return s;
  return p[2]+"/"+p[1]+"/"+p[0];
}
function todayISO(){ var d=new Date(); return d.toISOString().slice(0,10); }
function nextId(list){ var m=0; (list||[]).forEach(function(x){ if(x.id>m) m=x.id; }); return m+1; }

function accountById(id){ return (state.accounts||[]).find(function(a){return a.id===id;}); }
function catList(dir){ return (state.categories&&state.categories[dir])||[]; }
function catById(dir,id){ return catList(dir).find(function(c){return c.id===id;}); }
function subById(dir,catId,subId){ var c=catById(dir,catId); if(!c) return null; return (c.subs||[]).find(function(s){return s.id===subId;}); }

function computeAccountBalance(accId){
  var bal=0;
  var acc=accountById(accId);
  if(acc) bal=Number(acc.opening)||0;
  (state.transactions||[]).forEach(function(t){
    if(t.type==="entree" && t.accountId===accId) bal+=t.montant;
    else if(t.type==="sortie" && t.accountId===accId) bal-=t.montant;
    else if(t.type==="transfert"){
      if(t.accountId===accId) bal-=t.montant;
      if(t.toAccountId===accId) bal+=t.montant;
    }
  });
  return bal;
}
function totalTresorerie(){
  var t=0; (state.accounts||[]).forEach(function(a){ t+=computeAccountBalance(a.id); });
  return t;
}
function sumByType(type){
  var s=0; (state.transactions||[]).forEach(function(t){ if(t.type===type) s+=t.montant; });
  return s;
}
function categoryTotals(dir){
  var out={};
  (state.transactions||[]).forEach(function(t){
    if(t.type!==dir) return;
    var k=t.catId; out[k]=(out[k]||0)+t.montant;
  });
  return out;
}
function inSeason(dateStr){
  if(!dateStr) return false;
  var y=Number(dateStr.slice(0,4)), m=Number(dateStr.slice(5,7));
  var sy=state.meta.seasonStartYear;
  if(m>=7) return y===sy;
  return y===sy+1;
}
function seasonMonthIndex(dateStr){
  var m=Number(dateStr.slice(5,7));
  return m>=7?m-7:m+5;
}

/* ================= API / PERSISTENCE ================= */
function sectionQS(){
  /* L'administrateur général (super_admin) navigue entre plusieurs sections : on précise
     la section active dans l'URL. Pour un compte de section (admin/membre), le serveur
     déduit toujours la section depuis la session — inutile et non autorisé de la préciser. */
  if(currentUser&&currentUser.role==="super_admin"&&ui.activeSection){
    return "?section="+ui.activeSection;
  }
  return "";
}
function api(path,opts){
  opts=opts||{};
  var headers=Object.assign({"Content-Type":"application/json"},opts.headers||{});
  return fetch(path,Object.assign({credentials:"same-origin"},opts,{headers:headers})).then(function(res){
    return res.text().then(function(text){
      var data=null;
      if(text){ try{ data=JSON.parse(text); }catch(e){} }
      if(res.status===401){
        currentUser=null; state=null;
        authView={mode:"login",error:""};
        renderAuthScreen();
        var err=new Error("Session expirée, merci de vous reconnecter.");
        err.status=401; throw err;
      }
      if(!res.ok){
        var msg=(data&&(data.message||data.error))||("Erreur "+res.status);
        var err2=new Error(msg); err2.status=res.status; err2.data=data;
        throw err2;
      }
      return data;
    });
  });
}
function toast(msg,isErr){
  var wrap=document.getElementById("toastwrap");
  if(!wrap) return;
  var el=document.createElement("div");
  el.className="toast"+(isErr?" err":"");
  el.textContent=msg;
  wrap.appendChild(el);
  setTimeout(function(){ el.remove(); },3800);
}
function currentConfig(){
  return {meta:state.meta,accounts:state.accounts,categories:state.categories,budget:state.budget,refs:state.refs,anomalySettings:state.anomalySettings};
}
function saveConfig(successMsg){
  return api("/api/config"+sectionQS(),{method:"PUT",body:JSON.stringify(currentConfig())}).then(function(){
    if(successMsg) toast(successMsg);
    render();
  }).catch(function(e){
    toast("Échec de l'enregistrement : "+e.message,true);
    render();
  });
}

/* ================= BOOT / AUTH ================= */
function boot(){
  renderAuthScreen();
  api("/api/me").then(function(me){
    if(me.authenticated){
      currentUser=me.user;
      afterLogin();
    } else {
      authView={mode:me.needsSetup?"setup":"login",error:""};
      renderAuthScreen();
    }
  }).catch(function(){
    authView={mode:"login",error:""};
    renderAuthScreen();
  });
}
function afterLogin(){
  if(currentUser.role==="super_admin"){
    ui.activeSection=null; ui.tab="vue-globale"; state=null;
    render();
    refreshGlobalSections();
  } else {
    ui.activeSection=currentUser.sectionId;
    loadAppData();
  }
}
function loadAppData(){
  Promise.all([api("/api/config"+sectionQS()),api("/api/transactions"+sectionQS())]).then(function(results){
    state=results[0];
    state.transactions=results[1];
    render();
  }).catch(function(e){
    toast("Erreur de chargement : "+e.message,true);
  });
}
function refreshGlobalSections(){
  api("/api/sections").then(function(list){
    globalSections=list;
    if(ui.tab==="vue-globale"||ui.tab==="sections") render();
  }).catch(function(e){ toast("Erreur : "+e.message,true); });
}
function switchToSection(id){
  ui.activeSection=id;
  state=null;
  ui.tab="dashboard";
  render();
  loadAppData();
}
function switchToGlobal(){
  ui.activeSection=null;
  state=null;
  ui.tab="vue-globale";
  render();
  refreshGlobalSections();
}
function renderAuthScreen(){
  var root=document.getElementById("root");
  if(!root) return;
  if(authView.mode==="loading"){
    root.innerHTML="<div class=\"loadingscreen\">Chargement…</div>";
    return;
  }
  var isSetup=authView.mode==="setup";
  root.innerHTML="<div class=\"authwrap\"><div class=\"authcard\">"+
    "<div class=\"brand-name\">🏀 USL Trésorerie</div>"+
    "<div class=\"brand-sub\">"+(isSetup?"Créer le compte administrateur général de l'association":"Connexion à l'association")+"</div>"+
    (authView.error?"<div class=\"err\">"+escHtml(authView.error)+"</div>":"")+
    "<form id=\"auth-form\">"+
      (isSetup?"<div class=\"field\"><label>Nom affiché</label><input type=\"text\" id=\"auth-display\" required></div>":"")+
      "<div class=\"field\"><label>Identifiant</label><input type=\"text\" id=\"auth-username\" required autocomplete=\"username\"></div>"+
      "<div class=\"field\"><label>Mot de passe"+(isSetup?" (6 caractères minimum)":"")+"</label><input type=\"password\" id=\"auth-password\" required autocomplete=\""+(isSetup?"new-password":"current-password")+"\"></div>"+
      "<button class=\"btn btn-primary\" type=\"submit\">"+(isSetup?"Créer le compte":"Se connecter")+"</button>"+
    "</form>"+
    (isSetup?"":"<div class=\"switch\">Premier accès à l'application ? Le premier compte créé devient administrateur général.</div>")+
    "</div></div>";
  var form=document.getElementById("auth-form");
  form.addEventListener("submit",function(e){
    e.preventDefault();
    var username=document.getElementById("auth-username").value.trim();
    var password=document.getElementById("auth-password").value;
    var displayName=isSetup?document.getElementById("auth-display").value.trim():undefined;
    var path=isSetup?"/api/setup":"/api/login";
    var payload=isSetup?{username:username,password:password,displayName:displayName}:{username:username,password:password};
    api(path,{method:"POST",body:JSON.stringify(payload)}).then(function(data){
      currentUser=data.user;
      authView={mode:"login",error:""};
      afterLogin();
    }).catch(function(err){
      authView.error=err.message||"Erreur";
      renderAuthScreen();
    });
  });
}

/* ================= RENDER ROOT / NAV ================= */
var DATA_NAV=[
  {group:"Vue d'ensemble",items:[{id:"dashboard",label:"Tableau de bord",ic:"◈"}]},
  {group:"Saisie",items:[{id:"mouvements",label:"Mouvements",ic:"☷"}]},
  {group:"Structure",items:[{id:"comptes",label:"Comptes",ic:"▤"},{id:"categories",label:"Catégories",ic:"≡"},{id:"referentiels",label:"Référentiels",ic:"⚙"}]},
  {group:"Budget",items:[{id:"budget",label:"Budget prévisionnel",ic:"▣"},{id:"resultat",label:"Réalisé vs prévisionnel",ic:"⚖"}]},
  {group:"Analyses",items:[{id:"mensuelle",label:"Analyse mensuelle",ic:"▦"},{id:"depenses-recettes",label:"Dépenses / recettes",ic:"▥"}]},
  {group:"Contrôle",items:[{id:"bilan",label:"Bilan / trésorerie",ic:"◉"},{id:"anomalies",label:"Anomalies",ic:"⚠"}]}
];
var TAB_TITLES={dashboard:"Tableau de bord",mouvements:"Mouvements",comptes:"Comptes",categories:"Catégories",referentiels:"Référentiels",budget:"Budget prévisionnel",resultat:"Réalisé vs prévisionnel",mensuelle:"Analyse mensuelle",'depenses-recettes':"Analyse dépenses / recettes",bilan:"Bilan et trésorerie",anomalies:"Détection d'anomalies",users:"Utilisateurs",'vue-globale':"Vue globale de l'association",sections:"Sections"};

function buildNav(isSuper,isAdmin,hasSection){
  var groups=[];
  if(isSuper) groups.push({group:"Association",items:[{id:"vue-globale",label:"Vue globale",ic:"🌐"}]});
  if(hasSection) DATA_NAV.forEach(function(g){ groups.push(g); });
  var adminItems=[];
  if(isAdmin) adminItems.push({id:"users",label:"Utilisateurs",ic:"◍"});
  if(isSuper) adminItems.push({id:"sections",label:"Sections",ic:"▧"});
  if(adminItems.length) groups.push({group:"Administration",items:adminItems});
  return groups;
}

function render(){
  if(!currentUser){ renderAuthScreen(); return; }
  var root=document.getElementById("root");
  var isSuper=currentUser.role==="super_admin";
  var isAdmin=isSuper||currentUser.role==="admin";
  var hasSection=!!ui.activeSection;

  if(hasSection&&!state){
    root.innerHTML="<div class=\"loadingscreen\">Chargement…</div>";
    return;
  }
  if(!hasSection&&isSuper&&["vue-globale","sections","users"].indexOf(ui.tab)===-1){
    ui.tab="vue-globale";
  }

  var navGroups=buildNav(isSuper,isAdmin,hasSection);
  var navHtml=navGroups.map(function(g){
    return "<div class=\"nav-group\"><div class=\"nav-group-label\">"+escHtml(g.group)+"</div>"+
      g.items.map(function(it){
        return "<button class=\"nav-btn"+(ui.tab===it.id?" active":"")+"\" data-nav=\""+it.id+"\"><span class=\"nav-ic\">"+it.ic+"</span>"+escHtml(it.label)+"</button>";
      }).join("")+"</div>";
  }).join("");

  var brandName=hasSection?state.meta.club:"USL Trésorerie";
  var brandSub=hasSection?("Saison "+state.meta.saison):"Vue de l'association";

  var sectionSwitcherHtml="";
  if(isSuper){
    var opts="<option value=\"\""+(hasSection?"":" selected")+">— Vue globale —</option>"+
      (globalSections||[]).map(function(s){return "<option value=\""+s.id+"\""+(String(ui.activeSection)===String(s.id)?" selected":"")+">"+escHtml(s.name)+"</option>";}).join("");
    sectionSwitcherHtml="<div class=\"section-switcher\"><label>Section active</label><select id=\"section-switch\">"+opts+"</select></div>";
  }

  var roleLabel=isSuper?"Admin général":(isAdmin?"Admin":"Membre");

  root.innerHTML=
    "<div id=\"appwrap\">"+
      "<nav class=\"sidebar\">"+
        "<div class=\"brand\"><div class=\"brand-name\">🏀 "+escHtml(brandName)+"</div><div class=\"brand-sub\">"+escHtml(brandSub)+"</div></div>"+
        sectionSwitcherHtml+
        navHtml+
        "<div class=\"sidebar-foot\">"+
          "<div class=\"whoami\">👤 <b>"+escHtml(currentUser.displayName)+"</b> <span class=\"roleflag"+(isAdmin?"":" member")+"\">"+roleLabel+"</span></div>"+
          (hasSection?"<button class=\"btn btn-ghost btn-sm\" data-action=\"open-settings\">⚙︎ Paramètres de la section</button>":"")+
          "<button class=\"btn btn-ghost btn-sm\" data-action=\"logout\">↩ Se déconnecter</button>"+
        "</div>"+
      "</nav>"+
      "<div class=\"main\">"+
        "<div class=\"topbar\"><div><h1>"+escHtml(TAB_TITLES[ui.tab]||"")+"</h1></div>"+
          "<div class=\"topbar-meta\">"+(hasSection?(state.transactions.length+" mouvement(s) enregistré(s)"):"")+"</div>"+
        "</div>"+
        "<div class=\"content\" id=\"tabcontent\"></div>"+
      "</div>"+
    "</div>";

  var tc=document.getElementById("tabcontent");
  var renderers={
    dashboard:renderDashboard, mouvements:renderMouvements, comptes:renderComptes,
    categories:renderCategories, referentiels:renderReferentiels, budget:renderBudget,
    resultat:renderResultat, mensuelle:renderMensuelle, 'depenses-recettes':renderDepensesRecettes,
    bilan:renderBilan, anomalies:renderAnomalies, users:renderUsers,
    'vue-globale':renderVueGlobale, sections:renderSections
  };
  (renderers[ui.tab]||(hasSection?renderDashboard:renderVueGlobale))(tc);

  var switchEl=document.getElementById("section-switch");
  if(switchEl){
    switchEl.addEventListener("change",function(){
      var v=this.value;
      if(v) switchToSection(Number(v)); else switchToGlobal();
    });
  }

  if(ui.modal) openModalContent(); else closeModalDom();
}

/* ================= VUE GLOBALE (administrateur général) ================= */
function renderVueGlobale(el){
  if(globalSections===null){ el.innerHTML="<div class=\"empty\">Chargement…</div>"; return; }
  if(!globalSections.length){
    el.innerHTML="<div class=\"card\"><div class=\"card-body\"><p>Aucune section n'a encore été créée pour l'association.</p>"+
      "<button class=\"btn btn-primary btn-sm\" data-nav=\"sections\">Créer la première section</button></div></div>";
    return;
  }
  var totRes=0,totTres=0,totProd=0,totCharges=0,totMv=0;
  globalSections.forEach(function(s){
    var sm=s.summary||{};
    totRes+=sm.resultat||0; totTres+=sm.tresorerie||0; totProd+=sm.produits||0; totCharges+=sm.charges||0; totMv+=sm.nbMouvements||0;
  });
  var rows=globalSections.map(function(s){
    var sm=s.summary||{};
    return "<tr><td>"+escHtml(s.name)+"</td>"+
      "<td class=\"num\">"+fmtMoney(sm.produits||0)+"</td>"+
      "<td class=\"num\">"+fmtMoney(sm.charges||0)+"</td>"+
      "<td class=\"num "+((sm.resultat||0)<0?"neg":"pos")+"\">"+fmtMoney(sm.resultat||0)+"</td>"+
      "<td class=\"num\">"+fmtMoney(sm.tresorerie||0)+"</td>"+
      "<td class=\"num\">"+(sm.nbMouvements||0)+"</td>"+
      "<td style=\"text-align:right\"><button class=\"btn btn-ghost btn-sm\" data-action=\"open-section\" data-id=\""+s.id+"\">Ouvrir →</button></td></tr>";
  }).join("");
  el.innerHTML=
    "<div class=\"grid-tiles\">"+
      "<div class=\"tile\"><div class=\"tile-label\">Sections</div><div class=\"tile-val\">"+globalSections.length+"</div></div>"+
      "<div class=\"tile\"><div class=\"tile-label\">Résultat cumulé</div><div class=\"tile-val "+(totRes<0?"neg":"pos")+"\">"+fmtMoney(totRes)+"</div></div>"+
      "<div class=\"tile\"><div class=\"tile-label\">Trésorerie cumulée</div><div class=\"tile-val\">"+fmtMoney(totTres)+"</div></div>"+
      "<div class=\"tile\"><div class=\"tile-label\">Mouvements enregistrés</div><div class=\"tile-val\">"+totMv+"</div></div>"+
    "</div>"+
    "<div class=\"card\"><div class=\"card-head\"><div><h2>Sections de l'association</h2><p>Chaque section est confidentielle aux autres. Cliquez pour l'ouvrir en détail.</p></div></div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Section</th><th class=\"num\">Produits</th><th class=\"num\">Charges</th><th class=\"num\">Résultat</th><th class=\"num\">Trésorerie</th><th class=\"num\">Mouvements</th><th></th></tr></thead><tbody>"+rows+"</tbody></table></div></div></div>";
}

/* ================= SECTIONS (administration, administrateur général) ================= */
function renderSections(el){
  if(globalSections===null){ el.innerHTML="<div class=\"empty\">Chargement…</div>"; return; }
  var rows=globalSections.map(function(s){
    var nbMv=(s.summary&&s.summary.nbMouvements)||0;
    return "<tr><td>"+escHtml(s.name)+"</td><td class=\"num\">"+nbMv+"</td>"+
      "<td style=\"text-align:right;white-space:nowrap\">"+
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"open-section\" data-id=\""+s.id+"\">Ouvrir</button> "+
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"rename-section\" data-id=\""+s.id+"\">Renommer</button> "+
      "<button class=\"btn btn-ghost btn-sm btn-danger\" data-action=\"delete-section\" data-id=\""+s.id+"\">Supprimer</button>"+
      "</td></tr>";
  }).join("");
  el.innerHTML="<div class=\"card\"><div class=\"card-head\"><div><h2>Sections de l'association</h2><p>Chaque section a ses propres comptes, mouvements et membres, invisibles pour les autres sections. Vous seul, en tant qu'administrateur général, voyez tout.</p></div></div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Nom</th><th class=\"num\">Mouvements</th><th></th></tr></thead><tbody>"+(rows||"<tr><td colspan=\"3\" class=\"empty\">Aucune section.</td></tr>")+"</tbody></table></div></div>"+
    "<div class=\"card-body\" style=\"border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap\">"+
      "<input type=\"text\" id=\"new-section-name\" placeholder=\"Nom de la nouvelle section (ex. Section Football)\" style=\"max-width:320px\">"+
      "<button class=\"btn btn-primary btn-sm\" data-action=\"add-section\">+ Créer la section</button>"+
    "</div></div>";
}

/* ================= DASHBOARD ================= */
function renderDashboard(el){
  var produits=sumByType("entree"), charges=sumByType("sortie"), resultat=produits-charges;
  var tresorerie=totalTresorerie();
  var accCards=(state.accounts||[]).map(function(a){
    var b=computeAccountBalance(a.id);
    return "<div class=\"tile\"><div class=\"tile-label\">"+escHtml(a.name)+"</div><div class=\"tile-val "+(b<0?"neg":"")+"\">"+fmtMoney(b)+"</div></div>";
  }).join("");

  var catTotSortie=categoryTotals("sortie");
  var topSortie=Object.keys(catTotSortie).map(function(k){return {id:Number(k),v:catTotSortie[k]};}).sort(function(a,b){return b.v-a.v;}).slice(0,5);
  var catTotEntree=categoryTotals("entree");
  var topEntree=Object.keys(catTotEntree).map(function(k){return {id:Number(k),v:catTotEntree[k]};}).sort(function(a,b){return b.v-a.v;}).slice(0,5);
  var maxS=Math.max.apply(null,topSortie.map(function(x){return x.v;}).concat([1]));
  var maxE=Math.max.apply(null,topEntree.map(function(x){return x.v;}).concat([1]));

  var recents=(state.transactions||[]).slice().sort(function(a,b){return (b.dateOp||"").localeCompare(a.dateOp||"");}).slice(0,8);

  el.innerHTML=
    "<div class=\"grid-tiles\">"+
      "<div class=\"tile\"><div class=\"tile-label\">Résultat de la saison</div><div class=\"tile-val "+(resultat<0?"neg":"pos")+"\">"+fmtMoney(resultat)+"</div><div class=\"tile-sub\">Produits − charges</div></div>"+
      "<div class=\"tile\"><div class=\"tile-label\">Total produits</div><div class=\"tile-val pos\">"+fmtMoney(produits)+"</div></div>"+
      "<div class=\"tile\"><div class=\"tile-label\">Total charges</div><div class=\"tile-val neg\">"+fmtMoney(charges)+"</div></div>"+
      "<div class=\"tile\"><div class=\"tile-label\">Trésorerie globale</div><div class=\"tile-val\">"+fmtMoney(tresorerie)+"</div><div class=\"tile-sub\">Tous comptes cumulés</div></div>"+
    "</div>"+
    "<div class=\"section-title\">Soldes par compte</div>"+
    "<div class=\"grid-tiles\">"+(accCards||"<div class=\"empty\">Aucun compte configuré.</div>")+"</div>"+
    "<div class=\"card\"><div class=\"card-head\"><div><h2>Derniers mouvements</h2><p>Les 8 opérations les plus récentes</p></div><button class=\"btn btn-primary btn-sm\" data-action=\"new-transaction\">+ Nouveau mouvement</button></div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\">"+renderTxTable(recents,false)+"</div></div></div>"+
    "<div class=\"card-head\" style=\"border:none;padding-left:0\"><h2>Répartition par catégorie</h2></div>"+
    "<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:16px\" class=\"resp-2col\">"+
    "<div class=\"card\"><div class=\"card-head\"><h2>Top charges</h2></div><div class=\"card-body\">"+
      (topSortie.length?topSortie.map(function(x){var c=catById("sortie",x.id);return barRow(c?c.name:"?",x.v,maxS,"var(--negative)");}).join(""):"<div class=\"empty\">Aucune donnée</div>")+
    "</div></div>"+
    "<div class=\"card\"><div class=\"card-head\"><h2>Top produits</h2></div><div class=\"card-body\">"+
      (topEntree.length?topEntree.map(function(x){var c=catById("entree",x.id);return barRow(c?c.name:"?",x.v,maxE,"var(--positive)");}).join(""):"<div class=\"empty\">Aucune donnée</div>")+
    "</div></div></div>";
}
function barRow(label,val,max,color){
  var pct=max>0?Math.round((val/max)*100):0;
  return "<div class=\"barrow\"><div class=\"lbl\" title=\""+escHtml(label)+"\">"+escHtml(label)+"</div>"+
    "<div class=\"bartrack\"><div class=\"barfill\" style=\"width:"+pct+"%;background:"+color+"\"></div></div>"+
    "<div class=\"barval\">"+fmtMoney(val)+"</div></div>";
}

/* ================= MOUVEMENTS ================= */
function filteredTx(){
  var f=ui.filters;
  var list=(state.transactions||[]).filter(function(t){
    if(f.type && t.type!==f.type) return false;
    if(f.compte && String(t.accountId)!==String(f.compte)) return false;
    if(f.cat && String(t.catId)!==String(f.cat)) return false;
    if(f.validOnly==="1" && !t.valide) return false;
    if(f.validOnly==="0" && t.valide) return false;
    if(f.from && (t.dateOp||"") < f.from) return false;
    if(f.to && (t.dateOp||"") > f.to) return false;
    if(f.q){
      var q=f.q.toLowerCase();
      var hay=[t.description,t.fournisseur,t.salarie,t.reference,t.commentaire,t.evenement].join(" ").toLowerCase();
      if(hay.indexOf(q)===-1) return false;
    }
    return true;
  });
  var k=ui.sort.key,dir=ui.sort.dir==="asc"?1:-1;
  list.sort(function(a,b){
    var av=a[k],bv=b[k];
    if(k==="montant"){ av=a.montant; bv=b.montant; return (av-bv)*dir; }
    av=av||""; bv=bv||"";
    if(av<bv) return -1*dir; if(av>bv) return 1*dir; return 0;
  });
  return list;
}
function renderTxTable(list,withActions){
  if(!list.length) return "<div class=\"empty\">Aucun mouvement.</div>";
  var rows=list.map(function(t){
    var acc=accountById(t.accountId);
    var catName="—", subName="";
    if(t.type!=="transfert"){
      var c=catById(t.type,t.catId);
      catName=c?c.name:"—";
      var s=subById(t.type,t.catId,t.subId);
      subName=s?s.name:"";
    } else {
      var toAcc=accountById(t.toAccountId);
      catName="Vers "+(toAcc?toAcc.name:"?");
    }
    var pillClass=t.type==="entree"?"pill-entree":(t.type==="sortie"?"pill-sortie":"pill-transfert");
    var pillLabel=t.type==="entree"?"Entrée":(t.type==="sortie"?"Sortie":"Transfert");
    var sign=t.type==="sortie"?"-":(t.type==="entree"?"+":"");
    var amtClass=t.type==="sortie"?"neg":(t.type==="entree"?"pos":"");
    return "<tr>"+
      "<td class=\"tabular\">"+fmtDate(t.dateOp)+"</td>"+
      "<td><span class=\"pill "+pillClass+"\">"+pillLabel+"</span></td>"+
      "<td class=\"num "+amtClass+"\">"+sign+fmtMoney(t.montant)+"</td>"+
      "<td>"+escHtml(acc?acc.name:"?")+"</td>"+
      "<td>"+escHtml(catName)+(subName?"<div style=\"color:var(--ink-faint);font-size:11.5px\">"+escHtml(subName)+"</div>":"")+"</td>"+
      "<td>"+escHtml(t.description||"")+(t.fournisseur?"<div style=\"color:var(--ink-faint);font-size:11.5px\">"+escHtml(t.fournisseur)+"</div>":"")+"</td>"+
      "<td style=\"text-align:center\">"+(t.valide?"<span class=\"pill pill-ok\">✓</span>":"<span class=\"pill pill-warn\">–</span>")+"</td>"+
      (withActions?("<td style=\"text-align:right;white-space:nowrap\"><button class=\"btn btn-ghost btn-sm\" data-action=\"edit-transaction\" data-id=\""+t.id+"\">Modifier</button> <button class=\"btn btn-ghost btn-sm btn-danger\" data-action=\"delete-transaction\" data-id=\""+t.id+"\">Supprimer</button></td>"):"")+
      "</tr>";
  }).join("");
  return "<table><thead><tr><th>Date opé.</th><th>Type</th><th class=\"num\">Montant</th><th>Compte</th><th>Catégorie</th><th>Description</th><th style=\"text-align:center\">Validé</th>"+(withActions?"<th></th>":"")+"</tr></thead><tbody>"+rows+"</tbody></table>";
}
function renderMouvements(el){
  var list=filteredTx();
  var totE=0,totS=0; list.forEach(function(t){ if(t.type==="entree") totE+=t.montant; else if(t.type==="sortie") totS+=t.montant; });
  var accOpts=(state.accounts||[]).map(function(a){return "<option value=\""+a.id+"\""+(ui.filters.compte==String(a.id)?" selected":"")+">"+escHtml(a.name)+"</option>";}).join("");
  var allCats=catList("sortie").concat(catList("entree"));
  var catOpts=allCats.map(function(c){return "<option value=\""+c.id+"\""+(ui.filters.cat==String(c.id)?" selected":"")+">"+escHtml(c.name)+"</option>";}).join("");

  el.innerHTML=
    "<div class=\"card\">"+
    "<div class=\"card-head\"><div><h2>Journal des mouvements</h2><p>"+list.length+" opération(s) affichée(s)</p></div>"+
    "<div style=\"display:flex;gap:8px\"><button class=\"btn btn-ghost\" data-action=\"export-mouvements\">Exporter (Excel)</button><button class=\"btn btn-primary\" data-action=\"new-transaction\">+ Nouveau mouvement</button></div></div>"+
    "<div class=\"filterbar\">"+
      "<input type=\"search\" placeholder=\"Rechercher…\" id=\"f-q\" value=\""+escHtml(ui.filters.q)+"\">"+
      "<select id=\"f-type\"><option value=\"\">Tous types</option><option value=\"entree\""+(ui.filters.type==="entree"?" selected":"")+">Entrée</option><option value=\"sortie\""+(ui.filters.type==="sortie"?" selected":"")+">Sortie</option><option value=\"transfert\""+(ui.filters.type==="transfert"?" selected":"")+">Transfert</option></select>"+
      "<select id=\"f-compte\"><option value=\"\">Tous comptes</option>"+accOpts+"</select>"+
      "<select id=\"f-cat\"><option value=\"\">Toutes catégories</option>"+catOpts+"</select>"+
      "<select id=\"f-valid\"><option value=\"\">Validé : tous</option><option value=\"1\""+(ui.filters.validOnly==="1"?" selected":"")+">Validés</option><option value=\"0\""+(ui.filters.validOnly==="0"?" selected":"")+">Non validés</option></select>"+
      "<input type=\"date\" id=\"f-from\" value=\""+escHtml(ui.filters.from)+"\" title=\"Du\">"+
      "<input type=\"date\" id=\"f-to\" value=\""+escHtml(ui.filters.to)+"\" title=\"Au\">"+
      "<button class=\"btn btn-ghost btn-sm\" data-action=\"reset-filters\">Réinitialiser</button>"+
    "</div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\">"+renderTxTable(list,true)+"</div></div>"+
    "<div class=\"card-body\" style=\"border-top:1px solid var(--border);display:flex;gap:24px;font-family:var(--font-mono)\">"+
      "<div>Entrées : <b class=\"pos\">"+fmtMoney(totE)+"</b></div><div>Sorties : <b class=\"neg\">"+fmtMoney(totS)+"</b></div><div>Solde : <b>"+fmtMoney(totE-totS)+"</b></div>"+
    "</div>"+
    "</div>";
}

/* ================= COMPTES ================= */
function renderComptes(el){
  var rows=(state.accounts||[]).map(function(a){
    var bal=computeAccountBalance(a.id);
    return "<tr><td>"+escHtml(a.name)+"</td><td class=\"num\">"+fmtMoney(a.opening)+"</td><td class=\"num "+(bal<0?"neg":"")+"\">"+fmtMoney(bal)+"</td>"+
      "<td style=\"text-align:right;white-space:nowrap\"><button class=\"btn btn-ghost btn-sm\" data-action=\"export-account\" data-id=\""+a.id+"\">Exporter (Excel)</button> <button class=\"btn btn-ghost btn-sm\" data-action=\"edit-account\" data-id=\""+a.id+"\">Modifier</button> <button class=\"btn btn-ghost btn-sm btn-danger\" data-action=\"delete-account\" data-id=\""+a.id+"\">Supprimer</button></td></tr>";
  }).join("");
  el.innerHTML="<div class=\"card\"><div class=\"card-head\"><div><h2>Comptes du club</h2><p>Caisse, banque, livret, trésorerie vive… chaque compte a un solde de départ et un solde calculé.</p></div>"+
    "<button class=\"btn btn-primary\" data-action=\"new-account\">+ Nouveau compte</button></div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Compte</th><th class=\"num\">Solde de départ</th><th class=\"num\">Solde actuel</th><th></th></tr></thead><tbody>"+(rows||"<tr><td colspan=\"4\" class=\"empty\">Aucun compte.</td></tr>")+"</tbody>"+
    "<tfoot><tr><td>Total trésorerie</td><td></td><td class=\"num\">"+fmtMoney(totalTresorerie())+"</td><td></td></tr></tfoot></table></div></div></div>";
}

/* ================= CATEGORIES ================= */
function renderCategories(el){
  function block(dir,label){
    var cats=catList(dir);
    var rows=cats.map(function(c){
      var subRows=(c.subs||[]).map(function(s){
        return "<div class=\"tag\">"+escHtml(s.name)+"<button data-action=\"delete-subcat\" data-dir=\""+dir+"\" data-cat=\""+c.id+"\" data-sub=\""+s.id+"\" title=\"Supprimer\">×</button></div>";
      }).join("");
      return "<div class=\"card\" style=\"margin-bottom:10px\"><div class=\"card-head\"><h2 style=\"font-size:14px\">"+escHtml(c.name)+"</h2>"+
        "<div><button class=\"btn btn-ghost btn-sm\" data-action=\"rename-cat\" data-dir=\""+dir+"\" data-cat=\""+c.id+"\">Renommer</button> <button class=\"btn btn-ghost btn-sm btn-danger\" data-action=\"delete-cat\" data-dir=\""+dir+"\" data-cat=\""+c.id+"\">Supprimer</button></div></div>"+
        "<div class=\"card-body\"><div class=\"taglist\">"+(subRows||"<span style=\"color:var(--ink-faint);font-size:12.5px\">Aucune sous-catégorie</span>")+"</div>"+
        "<div style=\"margin-top:10px;display:flex;gap:8px\"><input type=\"text\" placeholder=\"Ajouter une sous-catégorie…\" id=\"newsub-"+dir+"-"+c.id+"\" style=\"max-width:260px\"><button class=\"btn btn-sm\" data-action=\"add-subcat\" data-dir=\""+dir+"\" data-cat=\""+c.id+"\">Ajouter</button></div>"+
        "</div></div>";
    }).join("");
    return "<div class=\"section-title\">"+label+"</div>"+
      "<div style=\"display:flex;justify-content:flex-end;margin-bottom:8px\"><div style=\"display:flex;gap:8px\"><input type=\"text\" id=\"newcat-"+dir+"\" placeholder=\"Nouvelle catégorie "+label.toLowerCase()+"…\" style=\"max-width:260px\"><button class=\"btn btn-sm btn-primary\" data-action=\"add-cat\" data-dir=\""+dir+"\">+ Catégorie</button></div></div>"+
      (rows||"<div class=\"empty\">Aucune catégorie.</div>");
  }
  el.innerHTML="<p style=\"color:var(--ink-faint);margin-top:0\">Les catégories de dépenses et de recettes sont séparées, comme dans le classeur d'origine. Vous pouvez les adapter librement.</p>"+
    block("sortie","Dépenses (sortie)")+block("entree","Recettes (entrée)");
}

/* ================= REFERENTIELS ================= */
function renderReferentiels(el){
  function listBlock(key,label,hint){
    var items=(state.refs[key]||[]);
    var tags=items.map(function(v,i){return "<div class=\"tag\">"+escHtml(v)+"<button data-action=\"delete-ref\" data-key=\""+key+"\" data-idx=\""+i+"\">×</button></div>";}).join("");
    return "<div class=\"card\"><div class=\"card-head\"><div><h2>"+label+"</h2><p>"+hint+"</p></div></div>"+
      "<div class=\"card-body\"><div class=\"taglist\" style=\"margin-bottom:10px\">"+(tags||"<span style=\"color:var(--ink-faint);font-size:12.5px\">Liste vide</span>")+"</div>"+
      "<div style=\"display:flex;gap:8px\"><input type=\"text\" id=\"newref-"+key+"\" placeholder=\"Ajouter…\" style=\"max-width:280px\"><button class=\"btn btn-sm\" data-action=\"add-ref\" data-key=\""+key+"\">Ajouter</button></div></div></div>";
  }
  el.innerHTML=listBlock("fournisseurs","Fournisseurs / prestataires","Proposés en saisie de mouvement.")+
    listBlock("salaries","Salariés","Personnel rémunéré par le club.")+
    listBlock("evenements","Événements","Manifestations, tournois, stages…");
}

/* ================= BUDGET ================= */
function renderBudget(el){
  function block(dir,label){
    var cats=catList(dir);
    var rows=cats.map(function(c){
      var v=(state.budget[dir]||{})[c.id]||0;
      return "<tr><td>"+escHtml(c.name)+"</td><td class=\"num\"><input type=\"number\" step=\"0.01\" min=\"0\" class=\"tabular\" style=\"text-align:right;max-width:130px\" data-budget-dir=\""+dir+"\" data-budget-cat=\""+c.id+"\" value=\""+v+"\"></td></tr>";
    }).join("");
    var total=cats.reduce(function(s,c){return s+((state.budget[dir]||{})[c.id]||0);},0);
    return "<div class=\"card\"><div class=\"card-head\"><h2>"+label+"</h2></div><div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Catégorie</th><th class=\"num\">Budget saison</th></tr></thead><tbody>"+rows+"</tbody>"+
      "<tfoot><tr><td>Total</td><td class=\"num\">"+fmtMoney(total)+"</td></tr></tfoot></table></div></div></div>";
  }
  el.innerHTML="<p style=\"color:var(--ink-faint);margin-top:0\">Saisissez le budget prévisionnel par catégorie pour la saison "+escHtml(state.meta.saison)+". Ces montants servent de référence dans l'onglet « Réalisé vs prévisionnel ».</p>"+
    "<div style=\"display:flex;justify-content:flex-end;margin-bottom:10px\"><button class=\"btn btn-primary btn-sm\" data-action=\"save-budget\">Enregistrer le budget</button></div>"+
    block("sortie","Dépenses prévues")+block("entree","Recettes prévues");
}

/* ================= RESULTAT (realise vs previsionnel) ================= */
function renderResultat(el){
  var totS=categoryTotals("sortie"), totE=categoryTotals("entree");
  function block(dir,label,goodWhenRealizedLower){
    var cats=catList(dir);
    var tot=dir==="sortie"?totS:totE;
    var rows=cats.map(function(c){
      var real=tot[c.id]||0;
      var bud=(state.budget[dir]||{})[c.id]||0;
      var ratio=bud>0?(real/bud*100):(real>0?100:0);
      var ok = goodWhenRealizedLower? (real<=bud) : (real>=bud);
      var okKnown = bud>0 || real>0;
      return "<tr><td>"+escHtml(c.name)+"</td><td class=\"num\">"+fmtMoney(real)+"</td><td class=\"num\">"+fmtMoney(bud)+"</td>"+
        "<td class=\"num\">"+(bud>0?ratio.toFixed(0)+"%":"—")+"</td>"+
        "<td style=\"text-align:center\">"+(okKnown?("<span class=\"pill "+(ok?"pill-ok":"pill-ko")+"\">"+(ok?"OK":"À surveiller")+"</span>"):"—")+"</td></tr>";
    }).join("");
    var realTot=cats.reduce(function(s,c){return s+(tot[c.id]||0);},0);
    var budTot=cats.reduce(function(s,c){return s+((state.budget[dir]||{})[c.id]||0);},0);
    return "<div class=\"card\"><div class=\"card-head\"><h2>"+label+"</h2></div><div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Catégorie</th><th class=\"num\">Réalisé</th><th class=\"num\">Prévisionnel</th><th class=\"num\">%</th><th style=\"text-align:center\">Statut</th></tr></thead><tbody>"+rows+"</tbody>"+
      "<tfoot><tr><td>Total</td><td class=\"num\">"+fmtMoney(realTot)+"</td><td class=\"num\">"+fmtMoney(budTot)+"</td><td colspan=\"2\"></td></tr></tfoot></table></div></div></div>";
  }
  var produits=sumByType("entree"),charges=sumByType("sortie");
  el.innerHTML="<div class=\"grid-tiles\">"+
    "<div class=\"tile\"><div class=\"tile-label\">Résultat réalisé</div><div class=\"tile-val "+((produits-charges)<0?"neg":"pos")+"\">"+fmtMoney(produits-charges)+"</div></div>"+
    "<div class=\"tile\"><div class=\"tile-label\">Résultat prévisionnel</div><div class=\"tile-val\">"+fmtMoney(sumBudget("entree")-sumBudget("sortie"))+"</div></div>"+
    "</div>"+
    block("sortie","Dépenses — réalisé vs budget (OK si réalisé ≤ budget)",true)+
    block("entree","Recettes — réalisé vs budget (OK si réalisé ≥ budget)",false);
}
function sumBudget(dir){
  var cats=catList(dir); var b=state.budget[dir]||{};
  return cats.reduce(function(s,c){return s+(b[c.id]||0);},0);
}

/* ================= ANALYSE MENSUELLE ================= */
function renderMensuelle(el){
  function block(dir,label){
    var cats=catList(dir);
    var matrix={};
    cats.forEach(function(c){ matrix[c.id]=new Array(12).fill(0); });
    (state.transactions||[]).forEach(function(t){
      if(t.type!==dir) return;
      if(!inSeason(t.dateOp)) return;
      if(matrix[t.catId]===undefined) return;
      matrix[t.catId][seasonMonthIndex(t.dateOp)]+=t.montant;
    });
    var monthTotals=new Array(12).fill(0);
    var head=MONTH_LABELS.map(function(m,i){return "<th class=\"num\">"+m.slice(0,4)+"</th>";}).join("");
    var rows=cats.map(function(c){
      var arr=matrix[c.id]; var rowTot=0;
      var cells=arr.map(function(v,i){ rowTot+=v; monthTotals[i]+=v; return "<td class=\"num\">"+(v?fmtMoney(v):"·")+"</td>"; }).join("");
      return "<tr><td>"+escHtml(c.name)+"</td>"+cells+"<td class=\"num\" style=\"font-weight:700\">"+fmtMoney(rowTot)+"</td></tr>";
    }).join("");
    var grand=monthTotals.reduce(function(a,b){return a+b;},0);
    var footCells=monthTotals.map(function(v){return "<td class=\"num\">"+fmtMoney(v)+"</td>";}).join("");
    return "<div class=\"card\"><div class=\"card-head\"><h2>"+label+"</h2></div><div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Catégorie</th>"+head+"<th class=\"num\">Total</th></tr></thead><tbody>"+rows+"</tbody>"+
      "<tfoot><tr><td>Total</td>"+footCells+"<td class=\"num\">"+fmtMoney(grand)+"</td></tr></tfoot></table></div></div></div>";
  }
  el.innerHTML="<p style=\"color:var(--ink-faint);margin-top:0\">Saison "+escHtml(state.meta.saison)+" (juillet à juin), basée sur la date d'opération. Modifiable dans Paramètres du club.</p>"+
    block("entree","Entrées par mois")+block("sortie","Sorties par mois");
}

/* ================= DEPENSES / RECETTES ================= */
function renderDepensesRecettes(el){
  var totS=categoryTotals("sortie"),totE=categoryTotals("entree");
  var sumS=Object.keys(totS).reduce(function(s,k){return s+totS[k];},0);
  var sumE=Object.keys(totE).reduce(function(s,k){return s+totE[k];},0);
  function block(dir,label,tot,sum,color){
    var cats=catList(dir).filter(function(c){return (tot[c.id]||0)>0;}).sort(function(a,b){return (tot[b.id]||0)-(tot[a.id]||0);});
    if(!cats.length) return "<div class=\"card\"><div class=\"card-head\"><h2>"+label+"</h2></div><div class=\"card-body\"><div class=\"empty\">Aucune donnée.</div></div></div>";
    var rows=cats.map(function(c){
      var v=tot[c.id]||0; var pct=sum>0?(v/sum*100):0;
      return "<div class=\"barrow\"><div class=\"lbl\">"+escHtml(c.name)+"</div><div class=\"bartrack\"><div class=\"barfill\" style=\"width:"+pct.toFixed(1)+"%;background:"+color+"\"></div></div><div class=\"barval\">"+fmtMoney(v)+" <span style=\"color:var(--ink-faint)\">("+pct.toFixed(0)+"%)</span></div></div>";
    }).join("");
    return "<div class=\"card\"><div class=\"card-head\"><h2>"+label+"</h2><p>Total "+fmtMoney(sum)+"</p></div><div class=\"card-body\">"+rows+"</div></div>";
  }
  el.innerHTML=block("sortie","Répartition des dépenses",totS,sumS,"var(--negative)")+block("entree","Répartition des recettes",totE,sumE,"var(--positive)");
}

/* ================= BILAN / TRESORERIE ================= */
function renderBilan(el){
  var rows=(state.accounts||[]).map(function(a){
    var mv=computeAccountBalance(a.id)-(Number(a.opening)||0);
    return "<tr><td>"+escHtml(a.name)+"</td><td class=\"num\">"+fmtMoney(a.opening)+"</td><td class=\"num "+(mv<0?"neg":"pos")+"\">"+fmtMoney(mv)+"</td><td class=\"num\">"+fmtMoney(computeAccountBalance(a.id))+"</td></tr>";
  }).join("");
  var produits=sumByType("entree"),charges=sumByType("sortie");
  el.innerHTML="<div class=\"grid-tiles\">"+
    "<div class=\"tile\"><div class=\"tile-label\">Trésorerie totale</div><div class=\"tile-val\">"+fmtMoney(totalTresorerie())+"</div></div>"+
    "<div class=\"tile\"><div class=\"tile-label\">Résultat de la saison</div><div class=\"tile-val "+((produits-charges)<0?"neg":"pos")+"\">"+fmtMoney(produits-charges)+"</div></div>"+
    "</div>"+
    "<div class=\"card\"><div class=\"card-head\"><h2>Situation par compte</h2></div><div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Compte</th><th class=\"num\">Solde de départ</th><th class=\"num\">Mouvements</th><th class=\"num\">Solde actuel</th></tr></thead><tbody>"+(rows||"<tr><td colspan=\"4\" class=\"empty\">Aucun compte.</td></tr>")+"</tbody>"+
    "<tfoot><tr><td>Total</td><td></td><td></td><td class=\"num\">"+fmtMoney(totalTresorerie())+"</td></tr></tfoot></table></div></div></div>";
}

/* ================= ANOMALIES ================= */
function findAnomalies(){
  var s=state.anomalySettings||{seuilHaut:10000,seuilBas:0};
  var list=state.transactions||[];
  var dupKey={};
  list.forEach(function(t){
    var k=[t.dateOp,t.type,t.montant,t.accountId,(t.description||"").trim().toLowerCase()].join("|");
    dupKey[k]=(dupKey[k]||[]).concat([t]);
  });
  var out=[];
  list.forEach(function(t){
    var reasons=[];
    var k=[t.dateOp,t.type,t.montant,t.accountId,(t.description||"").trim().toLowerCase()].join("|");
    if(dupKey[k] && dupKey[k].length>1) reasons.push("Doublon probable");
    if(t.montant>s.seuilHaut) reasons.push("Montant élevé (> "+fmtMoney(s.seuilHaut)+")");
    if(t.montant<=s.seuilBas) reasons.push("Montant nul ou négatif");
    if(t.type!=="transfert" && !t.catId) reasons.push("Non catégorisé");
    if(!t.valide) reasons.push("Non validé");
    if(reasons.length) out.push({t:t,reasons:reasons});
  });
  return out;
}
function renderAnomalies(el){
  var s=state.anomalySettings||{seuilHaut:10000,seuilBas:0};
  var anomalies=findAnomalies();
  var rows=anomalies.map(function(a){
    var t=a.t; var acc=accountById(t.accountId);
    return "<tr><td class=\"tabular\">"+fmtDate(t.dateOp)+"</td><td>"+(t.type==="entree"?"<span class=\"pill pill-entree\">Entrée</span>":t.type==="sortie"?"<span class=\"pill pill-sortie\">Sortie</span>":"<span class=\"pill pill-transfert\">Transfert</span>")+"</td>"+
      "<td class=\"num\">"+fmtMoney(t.montant)+"</td><td>"+escHtml(acc?acc.name:"?")+"</td><td>"+escHtml(t.description||"")+"</td>"+
      "<td>"+a.reasons.map(function(r){return "<span class=\"pill pill-warn\" style=\"margin:1px\">"+escHtml(r)+"</span>";}).join(" ")+"</td>"+
      "<td style=\"text-align:right\"><button class=\"btn btn-ghost btn-sm\" data-action=\"edit-transaction\" data-id=\""+t.id+"\">Corriger</button></td></tr>";
  }).join("");
  el.innerHTML="<div class=\"card\"><div class=\"card-head\"><div><h2>Paramètres de détection</h2></div></div><div class=\"card-body\">"+
    "<div class=\"formgrid\"><div class=\"field\"><label>Seuil montant élevé (€)</label><input type=\"number\" id=\"an-haut\" value=\""+s.seuilHaut+"\"></div>"+
    "<div class=\"field\"><label>Seuil montant bas (≤)</label><input type=\"number\" id=\"an-bas\" value=\""+s.seuilBas+"\"></div></div>"+
    "<button class=\"btn btn-sm btn-primary\" data-action=\"save-anomaly-settings\">Appliquer</button></div></div>"+
    "<div class=\"card\"><div class=\"card-head\"><div><h2>Anomalies détectées</h2><p>"+anomalies.length+" mouvement(s) à vérifier sur "+(state.transactions||[]).length+"</p></div></div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Date</th><th>Type</th><th class=\"num\">Montant</th><th>Compte</th><th>Description</th><th>Anomalie(s)</th><th></th></tr></thead><tbody>"+(rows||"<tr><td colspan=\"7\" class=\"empty\">Aucune anomalie détectée 🎉</td></tr>")+"</tbody></table></div></div></div>";
}

/* ================= UTILISATEURS ================= */
function renderUsers(el){
  if(!ui.users){
    el.innerHTML="<div class=\"empty\">Chargement…</div>";
    return;
  }
  var isSuper=currentUser.role==="super_admin";
  var rows=ui.users.map(function(u){
    var isSelf=currentUser&&currentUser.id===u.id;
    var roleLabel=u.role==="super_admin"?"Admin général":(u.role==="admin"?"Admin section":"Membre");
    var roleClass=u.role==="member"?" member":"";
    var actions="";
    if(u.role!=="super_admin"){
      actions+="<button class=\"btn btn-ghost btn-sm\" data-action=\"toggle-role\" data-id=\""+u.id+"\" data-role=\""+(u.role==="admin"?"member":"admin")+"\">"+(u.role==="admin"?"Rétrograder":"Promouvoir admin")+"</button> ";
    }
    actions+="<button class=\"btn btn-ghost btn-sm\" data-action=\"reset-password\" data-id=\""+u.id+"\">Changer mot de passe</button> ";
    if(!(u.role==="super_admin"&&isSelf)){
      actions+="<button class=\"btn btn-ghost btn-sm btn-danger\" data-action=\"delete-user\" data-id=\""+u.id+"\">Supprimer</button>";
    }
    return "<tr><td>"+escHtml(u.displayName)+(isSelf?" <span style=\"color:var(--ink-faint);font-size:11.5px\">(vous)</span>":"")+"</td>"+
      "<td>"+escHtml(u.username)+"</td>"+
      (isSuper?("<td>"+escHtml(u.sectionName||"—")+"</td>"):"")+
      "<td><span class=\"roleflag"+roleClass+"\">"+roleLabel+"</span></td>"+
      "<td style=\"text-align:right;white-space:nowrap\">"+actions+"</td></tr>";
  }).join("");
  var sectionField=isSuper?("<div class=\"field\"><label>Section</label><select id=\"nu-section\"><option value=\"\">Choisir…</option>"+opt(globalSections||[],"")+"</select></div>"):"";
  el.innerHTML="<div class=\"card\"><div class=\"card-head\"><div><h2>"+(isSuper?"Comptes de l'association":"Comptes de la section")+"</h2><p>Gérez qui peut se connecter à l'application.</p></div></div>"+
    "<div class=\"card-body pad0\"><div class=\"tablewrap\"><table><thead><tr><th>Nom</th><th>Identifiant</th>"+(isSuper?"<th>Section</th>":"")+"<th>Rôle</th><th></th></tr></thead><tbody>"+(rows||("<tr><td colspan=\""+(isSuper?5:4)+"\" class=\"empty\">Aucun utilisateur.</td></tr>"))+"</tbody></table></div></div></div>"+
    "<div class=\"card\"><div class=\"card-head\"><h2>Ajouter un membre</h2></div><div class=\"card-body\">"+
    "<div class=\"formgrid\">"+
    "<div class=\"field\"><label>Nom affiché</label><input type=\"text\" id=\"nu-display\"></div>"+
    "<div class=\"field\"><label>Identifiant</label><input type=\"text\" id=\"nu-username\"></div>"+
    "<div class=\"field\"><label>Mot de passe</label><input type=\"password\" id=\"nu-password\"></div>"+
    "<div class=\"field\"><label>Rôle</label><select id=\"nu-role\"><option value=\"member\">Membre</option><option value=\"admin\">Administrateur de section</option></select></div>"+
    sectionField+
    "</div><button class=\"btn btn-primary btn-sm\" data-action=\"add-user\">+ Créer le compte</button></div></div>";
}
function loadUsers(){
  api("/api/users").then(function(list){
    ui.users=list;
    if(ui.tab==="users") render();
  }).catch(function(e){ toast("Erreur : "+e.message,true); });
}

/* ================= MODALS ================= */
function closeModalDom(){
  var ov=document.getElementById("overlay");
  if(ov) ov.classList.remove("show");
}
function openModal(name,payload){
  ui.modal=name; ui.editing=payload||null;
  var ov=document.getElementById("overlay");
  ov.classList.add("show");
  openModalContent();
}
function closeModal(){
  ui.modal=null; ui.editing=null;
  closeModalDom();
}
function modalShell(title,bodyHtml,footHtml){
  return "<div class=\"modal-head\"><h3>"+title+"</h3><button class=\"btn btn-ghost iconbtn\" data-action=\"close-modal\">✕</button></div>"+
    "<div class=\"modal-body\">"+bodyHtml+"</div><div class=\"modal-foot\">"+footHtml+"</div>";
}
function openModalContent(){
  var box=document.getElementById("modalbox");
  if(!box) return;
  if(ui.modal==="transaction") box.innerHTML=transactionModal();
  else if(ui.modal==="account") box.innerHTML=accountModal();
  else if(ui.modal==="settings") box.innerHTML=settingsModal();
  else if(ui.modal==="confirm") box.innerHTML=confirmModal();
  bindDynamicModalInputs();
}
function bindDynamicModalInputs(){
  var typeSel=document.getElementById("tx-type");
  if(typeSel){ typeSel.addEventListener("change",refreshTxFormFields); refreshTxFormFields(); }
  var catSel=document.getElementById("tx-cat");
  if(catSel){ catSel.addEventListener("change",refreshTxSubOptions); }
}
function refreshTxFormFields(){
  var type=document.getElementById("tx-type").value;
  var isTransfer=type==="transfert";
  var catWrap=document.getElementById("tx-cat-wrap");
  var subWrap=document.getElementById("tx-sub-wrap");
  var toWrap=document.getElementById("tx-to-wrap");
  if(catWrap) catWrap.style.display=isTransfer?"none":"";
  if(subWrap) subWrap.style.display=isTransfer?"none":"";
  if(toWrap) toWrap.style.display=isTransfer?"":"none";
  if(!isTransfer){
    var catSel=document.getElementById("tx-cat");
    catSel.innerHTML=catList(type).map(function(c){return "<option value=\""+c.id+"\">"+escHtml(c.name)+"</option>";}).join("");
    refreshTxSubOptions();
  }
}
function refreshTxSubOptions(){
  var type=document.getElementById("tx-type").value;
  if(type==="transfert") return;
  var catId=Number(document.getElementById("tx-cat").value);
  var c=catById(type,catId);
  var subSel=document.getElementById("tx-sub");
  subSel.innerHTML=(c?c.subs:[]).map(function(s){return "<option value=\""+s.id+"\">"+escHtml(s.name)+"</option>";}).join("");
}
function opt(list,current){
  return list.map(function(x){ var id=x.id!==undefined?x.id:x; var label=x.name!==undefined?x.name:x; return "<option value=\""+id+"\""+(String(current)===String(id)?" selected":"")+">"+escHtml(label)+"</option>"; }).join("");
}
function datalistHtml(id,items){
  return "<datalist id=\""+id+"\">"+(items||[]).map(function(v){return "<option value=\""+escHtml(v)+"\">";}).join("")+"</datalist>";
}
function transactionModal(){
  var t=ui.editing||{id:null,type:"sortie",dateOp:todayISO(),dateSaisie:todayISO(),montant:"",accountId:(state.accounts[0]&&state.accounts[0].id)||"",toAccountId:"",catId:"",subId:"",fournisseur:"",salarie:"",description:"",reference:"",commentaire:"",evenement:"",valide:true};
  var accOptions=opt(state.accounts,t.accountId);
  var toAccOptions=opt(state.accounts,t.toAccountId);
  var body=
    "<div class=\"formgrid\">"+
    "<div class=\"field\"><label>Type de mouvement</label><select id=\"tx-type\">"+
      "<option value=\"sortie\""+(t.type==="sortie"?" selected":"")+">Sortie (dépense)</option>"+
      "<option value=\"entree\""+(t.type==="entree"?" selected":"")+">Entrée (recette)</option>"+
      "<option value=\"transfert\""+(t.type==="transfert"?" selected":"")+">Transfert entre comptes</option></select></div>"+
    "<div class=\"field\"><label>Montant (€)</label><input type=\"number\" step=\"0.01\" min=\"0.01\" id=\"tx-montant\" value=\""+escHtml(t.montant)+"\"></div>"+
    "<div class=\"field\"><label>Date de l'opération</label><input type=\"date\" id=\"tx-dateop\" value=\""+escHtml(t.dateOp)+"\"></div>"+
    "<div class=\"field\"><label>Date de saisie</label><input type=\"date\" id=\"tx-datesaisie\" value=\""+escHtml(t.dateSaisie)+"\"></div>"+
    "<div class=\"field\"><label>Compte"+"</label><select id=\"tx-account\">"+accOptions+"</select></div>"+
    "<div class=\"field\" id=\"tx-to-wrap\"><label>Compte destinataire</label><select id=\"tx-to-account\">"+toAccOptions+"</select></div>"+
    "<div class=\"field\" id=\"tx-cat-wrap\"><label>Catégorie</label><select id=\"tx-cat\"></select></div>"+
    "<div class=\"field\" id=\"tx-sub-wrap\"><label>Sous-catégorie</label><select id=\"tx-sub\"></select></div>"+
    "<div class=\"field\"><label>Fournisseur / prestataire</label><input type=\"text\" id=\"tx-fournisseur\" list=\"dl-fournisseurs\" value=\""+escHtml(t.fournisseur)+"\">"+datalistHtml("dl-fournisseurs",state.refs.fournisseurs)+"</div>"+
    "<div class=\"field\"><label>Salarié</label><input type=\"text\" id=\"tx-salarie\" list=\"dl-salaries\" value=\""+escHtml(t.salarie)+"\">"+datalistHtml("dl-salaries",state.refs.salaries)+"</div>"+
    "<div class=\"field span2\"><label>Description</label><input type=\"text\" id=\"tx-description\" value=\""+escHtml(t.description)+"\"></div>"+
    "<div class=\"field\"><label>Événement</label><input type=\"text\" id=\"tx-evenement\" list=\"dl-evenements\" value=\""+escHtml(t.evenement)+"\">"+datalistHtml("dl-evenements",state.refs.evenements)+"</div>"+
    "<div class=\"field\"><label>Référence</label><input type=\"text\" id=\"tx-reference\" value=\""+escHtml(t.reference)+"\"></div>"+
    "<div class=\"field span2\"><label>Commentaire</label><textarea id=\"tx-commentaire\">"+escHtml(t.commentaire)+"</textarea></div>"+
    "<div class=\"field span2 checkline\"><input type=\"checkbox\" id=\"tx-valide\""+(t.valide?" checked":"")+"><label for=\"tx-valide\" style=\"font-weight:500\">Mouvement validé / pointé</label></div>"+
    (t.createdBy?("<div class=\"field span2 hint\">Créé par "+escHtml(t.createdBy)+(t.updatedBy&&t.updatedBy!==t.createdBy?(", modifié par "+escHtml(t.updatedBy)):"")+"</div>"):"")+
    "</div>";
  var foot="<button class=\"btn btn-ghost\" data-action=\"close-modal\">Annuler</button><button class=\"btn btn-primary\" data-action=\"save-transaction\" data-id=\""+(t.id||"")+"\">Enregistrer</button>";
  return modalShell(t.id?"Modifier le mouvement":"Nouveau mouvement",body,foot);
}
function accountModal(){
  var a=ui.editing||{id:null,name:"",opening:0};
  var body="<div class=\"field\"><label>Nom du compte</label><input type=\"text\" id=\"acc-name\" value=\""+escHtml(a.name)+"\"></div>"+
    "<div class=\"field\"><label>Solde de départ (€)</label><input type=\"number\" step=\"0.01\" id=\"acc-opening\" value=\""+escHtml(a.opening)+"\"></div>";
  var foot="<button class=\"btn btn-ghost\" data-action=\"close-modal\">Annuler</button><button class=\"btn btn-primary\" data-action=\"save-account\" data-id=\""+(a.id||"")+"\">Enregistrer</button>";
  return modalShell(a.id?"Modifier le compte":"Nouveau compte",body,foot);
}
function settingsModal(){
  var body="<div class=\"field\"><label>Nom du club</label><input type=\"text\" id=\"set-club\" value=\""+escHtml(state.meta.club)+"\"></div>"+
    "<div class=\"field\"><label>Libellé de la saison</label><input type=\"text\" id=\"set-saison\" value=\""+escHtml(state.meta.saison)+"\"></div>"+
    "<div class=\"field\"><label>Année de début de saison</label><input type=\"number\" id=\"set-year\" value=\""+state.meta.seasonStartYear+"\"><span class=\"hint\">Utilisée pour l'analyse mensuelle (juillet → juin)</span></div>";
  var foot="<button class=\"btn btn-ghost\" data-action=\"close-modal\">Annuler</button><button class=\"btn btn-primary\" data-action=\"save-settings\">Enregistrer</button>";
  return modalShell("Paramètres du club",body,foot);
}
function confirmModal(){
  var c=ui.editing||{title:"Confirmer",message:"Êtes-vous sûr ?",action:""};
  var body="<p>"+escHtml(c.message)+"</p>";
  var foot="<button class=\"btn btn-ghost\" data-action=\"close-modal\">Annuler</button><button class=\"btn btn-danger\" data-action=\"confirm-yes\">Confirmer</button>";
  return modalShell(c.title,body,foot);
}

/* ================= ACTIONS / EVENT DELEGATION ================= */
document.addEventListener("click",function(e){
  var navBtn=e.target.closest("[data-nav]");
  if(navBtn){
    var navId=navBtn.getAttribute("data-nav");
    if(navId==="vue-globale"){ switchToGlobal(); return; }
    if(navId==="sections"){
      ui.activeSection=null; state=null; ui.tab="sections";
      render();
      if(globalSections===null) refreshGlobalSections();
      return;
    }
    ui.tab=navId;
    render();
    if(ui.tab==="users") loadUsers();
    return;
  }
  var btn=e.target.closest("[data-action]");
  if(!btn) return;
  var action=btn.getAttribute("data-action");
  var id=btn.getAttribute("data-id");
  switch(action){
    case "new-transaction": openModal("transaction",null); break;
    case "edit-transaction": {
      var t=(state.transactions||[]).find(function(x){return String(x.id)===String(id);});
      openModal("transaction",t?JSON.parse(JSON.stringify(t)):null); break;
    }
    case "delete-transaction": askConfirm("Supprimer le mouvement","Cette action est définitive.",function(){
      api("/api/transactions/"+id+sectionQS(),{method:"DELETE"}).then(function(){
        state.transactions=state.transactions.filter(function(x){return String(x.id)!==String(id);});
        toast("Mouvement supprimé."); render();
      }).catch(function(e){ toast("Erreur : "+e.message,true); render(); });
    }); break;
    case "close-modal": closeModal(); render(); break;
    case "save-transaction": submitTransaction(); break;
    case "new-account": openModal("account",null); break;
    case "edit-account": {
      var a=accountById(Number(id));
      openModal("account",a?JSON.parse(JSON.stringify(a)):null); break;
    }
    case "delete-account": askConfirm("Supprimer le compte","Les mouvements liés à ce compte resteront mais pointeront vers un compte inexistant. Continuer ?",function(){
      state.accounts=state.accounts.filter(function(x){return String(x.id)!==String(id);});
      saveConfig("Compte supprimé.");
    }); break;
    case "save-account": submitAccount(); break;
    case "open-settings": openModal("settings",null); break;
    case "save-settings": submitSettings(); break;
    case "confirm-yes": if(ui.confirm){ var fn=ui.confirm; ui.confirm=null; closeModal(); fn(); } break;
    case "reset-filters": ui.filters={q:"",type:"",compte:"",cat:"",validOnly:"",from:"",to:""}; render(); break;
    case "logout": api("/api/logout",{method:"POST"}).then(function(){
        currentUser=null; state=null; ui.tab="dashboard"; authView={mode:"login",error:""};
        renderAuthScreen();
      }); break;
    case "add-cat": {
      var dir=btn.getAttribute("data-dir");
      var inp=document.getElementById("newcat-"+dir);
      var name=inp&&inp.value.trim();
      if(name){ var list=catList(dir); list.push({id:nextId(list),name:name,subs:[]}); saveConfig("Catégorie ajoutée."); }
      break;
    }
    case "rename-cat": {
      var dir=btn.getAttribute("data-dir"), catId=Number(btn.getAttribute("data-cat"));
      var c=catById(dir,catId);
      var name=prompt("Nouveau nom de la catégorie",c?c.name:"");
      if(name&&name.trim()){ c.name=name.trim(); saveConfig("Catégorie renommée."); }
      break;
    }
    case "delete-cat": {
      var dir=btn.getAttribute("data-dir"), catId=Number(btn.getAttribute("data-cat"));
      askConfirm("Supprimer la catégorie","Les mouvements existants gardent la référence mais elle n'apparaîtra plus dans les listes.",function(){
        state.categories[dir]=catList(dir).filter(function(c){return c.id!==catId;});
        saveConfig("Catégorie supprimée.");
      });
      break;
    }
    case "add-subcat": {
      var dir=btn.getAttribute("data-dir"), catId=Number(btn.getAttribute("data-cat"));
      var inp=document.getElementById("newsub-"+dir+"-"+catId);
      var name=inp&&inp.value.trim();
      var c=catById(dir,catId);
      if(name&&c){ c.subs=c.subs||[]; c.subs.push({id:nextId(c.subs),name:name}); saveConfig("Sous-catégorie ajoutée."); }
      break;
    }
    case "delete-subcat": {
      var dir=btn.getAttribute("data-dir"), catId=Number(btn.getAttribute("data-cat")), subId=Number(btn.getAttribute("data-sub"));
      var c=catById(dir,catId);
      if(c){ c.subs=(c.subs||[]).filter(function(s){return s.id!==subId;}); saveConfig("Sous-catégorie supprimée."); }
      break;
    }
    case "add-ref": {
      var key=btn.getAttribute("data-key");
      var inp=document.getElementById("newref-"+key);
      var v=inp&&inp.value.trim();
      if(v){ state.refs[key]=state.refs[key]||[]; state.refs[key].push(v); saveConfig("Ajouté."); }
      break;
    }
    case "delete-ref": {
      var key=btn.getAttribute("data-key"); var idx=Number(btn.getAttribute("data-idx"));
      state.refs[key].splice(idx,1); saveConfig("Supprimé.");
      break;
    }
    case "save-budget": {
      var inputs=document.querySelectorAll("[data-budget-dir]");
      inputs.forEach(function(inp){
        var dir=inp.getAttribute("data-budget-dir"), cat=inp.getAttribute("data-budget-cat");
        state.budget[dir]=state.budget[dir]||{};
        state.budget[dir][cat]=Number(inp.value)||0;
      });
      saveConfig("Budget enregistré.");
      break;
    }
    case "save-anomaly-settings": {
      var h=Number(document.getElementById("an-haut").value)||0;
      var b=Number(document.getElementById("an-bas").value)||0;
      state.anomalySettings={seuilHaut:h,seuilBas:b};
      saveConfig("Seuils mis à jour.");
      break;
    }
    case "add-user": {
      var displayName=document.getElementById("nu-display").value.trim();
      var username=document.getElementById("nu-username").value.trim();
      var password=document.getElementById("nu-password").value;
      var role=document.getElementById("nu-role").value;
      var payload={username:username,password:password,displayName:displayName,role:role};
      if(currentUser.role==="super_admin"){
        var secEl=document.getElementById("nu-section");
        var sectionId=secEl&&Number(secEl.value);
        if(!sectionId){ toast("Choisissez une section pour ce compte.",true); break; }
        payload.sectionId=sectionId;
      }
      if(!username||password.length<6){ toast("Identifiant requis et mot de passe de 6 caractères minimum.",true); break; }
      api("/api/users",{method:"POST",body:JSON.stringify(payload)}).then(function(u){
        toast("Compte créé pour "+u.displayName+"."); loadUsers();
      }).catch(function(e){ toast("Erreur : "+e.message,true); });
      break;
    }
    case "open-section": switchToSection(Number(id)); break;
    case "add-section": {
      var inp=document.getElementById("new-section-name");
      var name=inp&&inp.value.trim();
      if(!name){ toast("Nom de section requis.",true); break; }
      api("/api/sections",{method:"POST",body:JSON.stringify({name:name})}).then(function(s){
        toast("Section « "+s.name+" » créée."); refreshGlobalSections();
      }).catch(function(e){ toast("Erreur : "+e.message,true); });
      break;
    }
    case "rename-section": {
      var secS=(globalSections||[]).find(function(x){return String(x.id)===String(id);});
      var newName=prompt("Nouveau nom de la section",secS?secS.name:"");
      if(newName&&newName.trim()){
        api("/api/sections/"+id,{method:"PUT",body:JSON.stringify({name:newName.trim()})}).then(function(){
          toast("Section renommée."); refreshGlobalSections();
        }).catch(function(e){ toast("Erreur : "+e.message,true); });
      }
      break;
    }
    case "delete-section": {
      var secD=(globalSections||[]).find(function(x){return String(x.id)===String(id);});
      askConfirm("Supprimer la section",(secD?("« "+secD.name+" » — "):"")+"possible uniquement si elle est vide (aucun mouvement, aucun membre).",function(){
        api("/api/sections/"+id,{method:"DELETE"}).then(function(){
          toast("Section supprimée."); refreshGlobalSections();
        }).catch(function(e){ toast("Erreur : "+e.message,true); });
      });
      break;
    }
    case "export-account": {
      var accId=Number(id);
      var acc=accountById(accId);
      var listAcc=(state.transactions||[]).filter(function(t){ return t.accountId===accId||t.toAccountId===accId; });
      downloadCsv("mouvements_"+slugify(acc?acc.name:accId)+".csv",txToCsvRows(listAcc));
      break;
    }
    case "export-mouvements": {
      downloadCsv("mouvements_"+slugify(state.meta.club)+".csv",txToCsvRows(filteredTx()));
      break;
    }
    case "toggle-role": {
      var newRole=btn.getAttribute("data-role");
      api("/api/users/"+id,{method:"PUT",body:JSON.stringify({role:newRole})}).then(function(u){
        ui.users=ui.users.map(function(x){return String(x.id)===String(id)?u:x;});
        toast("Rôle mis à jour."); render();
      }).catch(function(e){ toast("Erreur : "+e.message,true); });
      break;
    }
    case "reset-password": {
      var pw=prompt("Nouveau mot de passe (6 caractères minimum) :");
      if(!pw) break;
      if(pw.length<6){ toast("Mot de passe trop court.",true); break; }
      api("/api/users/"+id,{method:"PUT",body:JSON.stringify({password:pw})}).then(function(){
        toast("Mot de passe mis à jour.");
      }).catch(function(e){ toast("Erreur : "+e.message,true); });
      break;
    }
    case "delete-user": askConfirm("Supprimer ce compte","Cette personne ne pourra plus se connecter.",function(){
      api("/api/users/"+id,{method:"DELETE"}).then(function(){
        ui.users=ui.users.filter(function(x){return String(x.id)!==String(id);});
        toast("Compte supprimé."); render();
      }).catch(function(e){ toast("Erreur : "+e.message,true); render(); });
    }); break;
  }
});
document.addEventListener("change",function(e){
  var id=e.target.id;
  if(["f-type","f-compte","f-cat","f-valid","f-from","f-to"].indexOf(id)!==-1){
    var map={"f-type":"type","f-compte":"compte","f-cat":"cat","f-valid":"validOnly","f-from":"from","f-to":"to"};
    ui.filters[map[id]]=e.target.value; render();
  }
});
document.addEventListener("input",function(e){
  if(e.target.id==="f-q"){ ui.filters.q=e.target.value; render(); var el=document.getElementById("f-q"); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); } }
});
document.addEventListener("keydown",function(e){
  if(e.key==="Escape" && ui.modal){ closeModal(); render(); }
});

function askConfirm(title,message,fn){
  ui.confirm=fn;
  openModal("confirm",{title:title,message:message});
}

function submitTransaction(){
  var type=document.getElementById("tx-type").value;
  var montant=Number(document.getElementById("tx-montant").value);
  if(!montant||montant<=0){ toast("Montant invalide.",true); return; }
  var accountId=Number(document.getElementById("tx-account").value);
  var dateOp=document.getElementById("tx-dateop").value||todayISO();
  var dateSaisie=document.getElementById("tx-datesaisie").value||todayISO();
  var description=document.getElementById("tx-description").value.trim();
  var editId=document.getElementById("modalbox").querySelector("[data-action='save-transaction']").getAttribute("data-id");
  var tx={
    type:type, montant:montant, accountId:accountId,
    dateOp:dateOp, dateSaisie:dateSaisie,
    fournisseur:document.getElementById("tx-fournisseur").value.trim(),
    salarie:document.getElementById("tx-salarie").value.trim(),
    description:description,
    evenement:document.getElementById("tx-evenement").value.trim(),
    reference:document.getElementById("tx-reference").value.trim(),
    commentaire:document.getElementById("tx-commentaire").value.trim(),
    valide:document.getElementById("tx-valide").checked,
    catId:null, subId:null, toAccountId:null
  };
  if(type==="transfert"){
    tx.toAccountId=Number(document.getElementById("tx-to-account").value);
    if(tx.toAccountId===tx.accountId){ toast("Le compte destinataire doit être différent du compte source.",true); return; }
  } else {
    tx.catId=Number(document.getElementById("tx-cat").value);
    tx.subId=Number(document.getElementById("tx-sub").value)||null;
  }
  var req=editId?api("/api/transactions/"+editId+sectionQS(),{method:"PUT",body:JSON.stringify(tx)}):api("/api/transactions"+sectionQS(),{method:"POST",body:JSON.stringify(tx)});
  req.then(function(saved){
    if(editId){
      var idx=state.transactions.findIndex(function(x){return String(x.id)===String(editId);});
      if(idx>-1) state.transactions[idx]=saved;
    } else {
      state.transactions.unshift(saved);
    }
    var refsChanged=false;
    [["fournisseurs",tx.fournisseur],["salaries",tx.salarie],["evenements",tx.evenement]].forEach(function(p){
      if(p[1] && state.refs[p[0]].indexOf(p[1])===-1){ state.refs[p[0]].push(p[1]); refsChanged=true; }
    });
    closeModal();
    if(refsChanged){ saveConfig("Mouvement enregistré."); } else { toast("Mouvement enregistré."); render(); }
  }).catch(function(e){ toast("Erreur : "+e.message,true); });
}
function submitAccount(){
  var name=document.getElementById("acc-name").value.trim();
  if(!name){ toast("Nom requis.",true); return; }
  var opening=Number(document.getElementById("acc-opening").value)||0;
  var editId=document.getElementById("modalbox").querySelector("[data-action='save-account']").getAttribute("data-id");
  if(editId){
    var a=accountById(Number(editId));
    if(a){ a.name=name; a.opening=opening; }
  } else {
    state.accounts.push({id:nextId(state.accounts),name:name,opening:opening});
  }
  closeModal();
  saveConfig("Compte enregistré.");
}
function submitSettings(){
  state.meta.club=document.getElementById("set-club").value.trim()||state.meta.club;
  state.meta.saison=document.getElementById("set-saison").value.trim()||state.meta.saison;
  state.meta.seasonStartYear=Number(document.getElementById("set-year").value)||state.meta.seasonStartYear;
  closeModal();
  saveConfig("Paramètres enregistrés.");
}

/* ================= EXPORT EXCEL (CSV) ================= */
function csvEscape(v){
  var s=String(v===undefined||v===null?"":v);
  if(/[";\n]/.test(s)) s='"'+s.replace(/"/g,'""')+'"';
  return s;
}
function fmtNumCsv(n){ return String(Number(n)||0).replace(".",","); }
function slugify(s){
  return String(s||"export").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_+|_+$/g,"").toLowerCase()||"export";
}
function txToCsvRows(list){
  var header=["Date opération","Date saisie","Type","Montant","Compte","Compte destinataire","Catégorie","Sous-catégorie","Fournisseur","Salarié","Description","Événement","Référence","Commentaire","Validé","Créé par","Modifié par"];
  var lines=[header.map(csvEscape).join(";")];
  list.forEach(function(t){
    var acc=accountById(t.accountId);
    var toAcc=accountById(t.toAccountId);
    var catName="",subName="";
    if(t.type!=="transfert"){
      var c=catById(t.type,t.catId); catName=c?c.name:"";
      var s=subById(t.type,t.catId,t.subId); subName=s?s.name:"";
    }
    var typeLabel=t.type==="entree"?"Entrée":(t.type==="sortie"?"Sortie":"Transfert");
    lines.push([
      fmtDate(t.dateOp),fmtDate(t.dateSaisie),typeLabel,fmtNumCsv(t.montant),
      acc?acc.name:"",toAcc?toAcc.name:"",catName,subName,
      t.fournisseur||"",t.salarie||"",t.description||"",t.evenement||"",
      t.reference||"",t.commentaire||"",t.valide?"Oui":"Non",t.createdBy||"",t.updatedBy||""
    ].map(csvEscape).join(";"));
  });
  return lines.join("\r\n");
}
function downloadCsv(filename,content){
  var blob=new Blob(["\uFEFF"+content],{type:"text/csv;charset=utf-8;"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url; a.download=filename;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); },0);
}

/* ================= INIT ================= */
if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",boot); } else { boot(); }
})();
