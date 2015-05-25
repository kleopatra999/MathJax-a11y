
//
//  Patch MathJax processInput() to perform the postInputHooks
//  (this is part of the semantic-enhance branch, but this file
//   calls on the CDN rather than a local copy).
//
MathJax.Hub.postInputHooks = MathJax.Callback.Hooks(true);
MathJax.Hub.processInput = function (state) {
  var jax, STATE = MathJax.ElementJax.STATE;
  var script, prev, m = state.scripts.length;
  try {
    //
    //  Loop through the scripts
    //
    while (state.i < m) {
      script = state.scripts[state.i]; if (!script) {state.i++; continue}
      //
      //  Remove previous error marker, if any
      //
      prev = script.previousSibling;
      if (prev && prev.className === "MathJax_Error") {prev.parentNode.removeChild(prev)}
      //
      //  Check if already processed or needs processing
      //
      if (!script.MathJax || script.MathJax.state === STATE.PROCESSED) {state.i++; continue};
      if (!script.MathJax.elementJax || script.MathJax.state === STATE.UPDATE) {
        this.checkScriptSiblings(script);                 // remove preJax/postJax etc.
        var type = script.type.replace(/ *;(.|\s)*/,"");  // the input jax type
        var input = this.inputJax[type];                  // the input jax itself
        jax = input.Process(script,state);                // run the input jax
        if (typeof jax === 'function') {                  // if a callback was returned
          if (jax.called) continue;                       //   go back and call Process() again
          this.RestartAfter(jax);                         //   wait for the callback
        }
        jax = jax.Attach(script,input.id);                // register the jax on the script
        this.saveScript(jax,state,script,STATE);          // add script to state
        this.postInputHooks.Execute(jax,input.id,script); // run global jax filters
      } else if (script.MathJax.state === STATE.OUTPUT) {
        this.saveScript(script.MathJax.elementJax,state,script,STATE); // add script to state
      }
      //
      //  Go on to the next script, and check if we need to update the processing message
      //
      state.i++; var now = new Date().getTime();
      if (now - state.start > this.processUpdateTime && state.i < state.scripts.length)
        {state.start = now; this.RestartAfter(MathJax.Callback.Delay(1))}
    }
  } catch (err) {return this.processError(err,state,"Input")}
  //
  //  Put up final message, reset the state and return
  //
  if (state.scripts.length && this.config.showProcessingMessages)
    MathJax.Message.Set(["ProcessMath","Processing math: %1%%",100],0);
  state.start = new Date().getTime(); state.i = state.j = 0;
  return null;
};

//
//  The semantic-enrichment filter.
//
MathJax.Extension.SemanticMathML = {
  version: "1.0",
  enrich: false,
  running: false,
  //
  //  Names of attributes to force if set by mstyle
  //  (so SRE doesn't have to look these up)
  //
  mstyleLookup: {
    mi: ["mathvariant"],
    mo: ["mathvariant","accent","largeop","form","fence","separator","movablelimits"],
    mn: ["mathvariant"],
    mtext: ["mathvariant"],
    ms: ["mathvariant"],
    mfrac: ["linethickness"],
    mfenced: ["open","close","separators"],
    menclose: ["notation"],
    munder: ["accentunder"],
    mover: ["accent"],
    munderover: ["accent","accentunder"]
  },
  Filter: function (jax,id,script) {
    delete jax.enriched;
    this.running = true;
    if (this.enrich) jax.enriched = sre.Semantic.enrichMathml(jax.root.toMathML());
    this.running = false;
  },
  Enable: function () {this.enrich = true},
  Disable: function () {this.enrich = false}
};
MathJax.Hub.postInputHooks.Add(["Filter",MathJax.Extension.SemanticMathML]);
//
//  Override toMathML's attribute function to include additional attributes
//  inherited from mstyle (so SRE doesn't have to look them up).
//  Eventually, this should be moved to toMathML.js directly
//
MathJax.Hub.Register.StartupHook("toMathML Ready",function () {
  var MML = MathJax.ElementJax.mml,
      SMML = MathJax.Extension.SemanticMathML;
  MML.mbase.Augment({
    toMathMLattributes: function () {
      var defaults = (this.type === "mstyle" ? MML.math.prototype.defaults : this.defaults);
      var names = (this.attrNames||MML.copyAttributeNames),
          skip = MML.skipAttributes, copy = MML.copyAttributes,
          lookup = SMML.mstyleLookup[this.type]||[];
      var attr = [], ATTR = (this.attr||{});

      if (this.type === "math" && (!this.attr || !this.attr.xmlns))
        attr.push('xmlns="http://www.w3.org/1998/Math/MathML"');
      if (!this.attrNames) {
        for (var id in defaults) {if (!skip[id] && !copy[id] && defaults.hasOwnProperty(id)) {
          if (this[id] != null && this[id] !== defaults[id]) {
            if (this.Get(id,null,1) !== this[id]) this.toMathMLaddAttr(attr,id,this[id]);
          }
        }}
      }
      for (var i = 0, m = names.length; i < m; i++) {
        if (copy[names[i]] === 1 && !defaults.hasOwnProperty(names[i])) continue;
        value = ATTR[names[i]]; if (value == null) value = this[names[i]];
        if (value != null) this.toMathMLaddAttr(attr,names[i],value);
      }
      for (i = 0, m = lookup.length; i < m; i++) {
        id = lookup[i];
        if (defaults.hasOwnProperty(id) && !attr["_"+id]) {
          value = this.Get(id,1);
          if (value != null) this.toMathMLaddAttr(attr,id,value);
        }
      }
      this.toMathMLclass(attr);
      if (attr.length) return " "+attr.join(" "); else return "";
    },
    toMathMLaddAttr: function (attr,id,value) {
      attr.push(id+'="'+this.toMathMLquote(value)+'"');
      attr["_"+id] = 1;
    }
  });
});

//
//  A filter to convert the enhanced MathML to MathJax internal format
//  so we can display it, while adding maction elements for parts that
//  can be collapsed.  We determine this based on a "complexity" value
//  and collapse those terms that exceed a given complexity.
//
//  The parameters controlling the complexity measure still need work.
//
MathJax.Hub.Register.StartupHook("mml Jax Ready",function () {
  var MML = MathJax.ElementJax.mml;

  var Collapse = MathJax.Extension.Collapse = {
    version: "1.0",

    /*****************************************************************/

    //
    //  Complexity values to use for different structures
    //
    COMPLEXITY: {
      TEXT: .5,           // each character of a token element adds this to complexity
      TOKEN: .5,          // each toekn element gets this additional complexity
      CHILD: 1,           // child nodes add this to their parent node's complexity

      SCRIPT: .8,         // script elements reduce their complexity by this factor
      SQRT: 2,            // sqrt adds this extra complexity
      SUBSUP: 2,          // sub-sup adds this extra complexity
      UNDEROVER: 2,       // under-over adds this extra complexity
      FRACTION: 2,        // fractions add this extra complexity
      ACTION: 2,          // maction adds this extra complexity
      PHANTOM: 0,         // mphantom makes complexity 0?
      XML: 2,             // Can't really measure complexity of annotation-xml, so punt
      GLYPH: 2            // Can't really measure complexity of mglyph, to punt
    },
    //
    //  These are the cut-off complexity values for when
    //  the structure should collapse
    //
    COLLAPSE: {
      identifier: 3,
      number: 3,
      text: 10,
      infixop: 15,
      fenced: 18,
      bigop: 20,
      fraction: 12,
      sqrt: 9,
      root: 12,
      vector: 15,
      matrix: 15,
      superscript: 9,
      subscript: 9,
      subsup: 9,
      punctuated: 12
    },
    //
    //  These are the characters to use for the various collapsed elements
    //  (if an object, then semantic-role is used to get the character 
    //  from the object)
    //
    MARKER: {
      identifier: "x",
      number: "#",
      text: "...",
      appl: "f()",
      fraction: "/",
      sqrt: "\u221A",
      root: "\u221A",
      vector: "\u27E8:\u27E9",
      superscript: "\u25FD\u02D9",
      subscript: "\u25FD.",
      subsup:"\u25FD:",
      matrix: {
        squarematrix: "[::]",
        rowvector: "\u27E8\u22EF\u27E9",
        columnvector: "\u27E8\u22EE\u27E9",
        unknown: "(::)"
      },
      infixop: {
        addition: "+",
        subtraction: "\u2212",
        multiplication: "\u22C5",
        implicit: "\u22C5",
        default: "+"
      },
      punctuated: {
        text: "...",
        default: ","
      }
    },

    /*****************************************************************/

    //
    //  The main filter (convert the enriched MathML to the
    //  MathJax internal format, with collapsing).
    //
    Filter: function (jax,id,script) {
      if (jax.enriched /*&& jax.root.Get("display") === "block"*/) {
        if (jax.enriched.nodeName.toLowerCase() !== "math") {
          var math = document.createElement("math");
          math.appendChild(jax.enriched);
          jax.enriched = math;
        }
        jax.root = this.MakeMML(jax.enriched);
        jax.root.inputID = script.id;
        jax.root.SRE = {action: this.Actions(jax.root)};
      }
    },
    //
    //  Produce an array of collapsible actions
    //  sorted by depth and complexity
    //
    Actions: function (node) {
      var actions = [];
      this.getActions(node,0,actions);
      return this.sortActions(actions);
    },
    getActions: function (node,depth,actions) {
      depth++;
      for (var i = 0, m = node.data.length; i < m; i++) {
        if (node.data[i]) {
          var child = node.data[i];
          if (child.collapsible) {
            if (!actions[depth]) actions[depth] = [];
            actions[depth].push(child);
            this.getActions(child.data[1],depth,actions);
          } else if (!child.isToken) {
            this.getActions(child,depth,actions);
          }
        }
      }
    },
    sortActions: function (actions) {
      var ACTIONS = [];
      for (var i = 0, m = actions.length; i < m; i++) {
        if (actions[i]) ACTIONS = ACTIONS.concat(actions[i].sort(this.sortActionsBy));
      }
      return ACTIONS;
    },
    sortActionsBy: function (a,b) {
      a = a.data[1].complexity; b = b.data[1].complexity;
      return (a < b ? -1 : a > b ? 1 : 0);
    },
    
    //
    //  Find math that is too wide and collapse it
    //
    CollapseWideMath: function (element) {
      this.GetContainerWidths(element);
      var jax = MathJax.Hub.getAllJax(element);
      var state = {collapse: [], jax: jax, m: jax.length, i: 0, changed:false};
      return this.collapseState(state);
    },
    collapseState: function (state) {
      while (state.i < state.m) {
        var jax = state.jax[state.i], collapse = state.collapse;
        var SRE = jax.root.SRE; state.changed = false;
        if (SRE && SRE.action.length) {
          if (SRE.cwidth < SRE.m || SRE.cwidth > SRE.M) {
            var restart = this.getActionWidths(jax,state); if (restart) return restart;
            this.collapseActions(SRE,state);
            if (state.changed) collapse.push(jax.SourceElement());
          }
        }
        state.i++;
      }
      if (collapse.length === 0) return;
      if (collapse.length === 1) collapse = collapse[0];
      return MathJax.Hub.Rerender(collapse);
    },
    
    //
    //  Find the actions that need to be collapsed to acheive
    //  the correct width, and retain the sizes that would cause
    //  the equation to be expanded or collapsed further.
    //
    collapseActions: function (SRE,state) {
      var w = SRE.width ,m = w, M = 1000000;
      for (var j = SRE.action.length-1; j >= 0; j--) {
        var action = SRE.action[j], selection = action.selection;
        if (w > SRE.cwidth) {
          action.selection = 1;
          m = action.SREwidth; M = w;
        } else {
          action.selection = 2;
        }
        w = action.SREwidth;
        if (action.selection !== selection) state.changed = true;
      }
      SRE.m = m; SRE.M = M;
    },

    //
    //  Get the widths of the different collapsings,
    //  trapping any restarts, and restarting the process
    //  when the event has occurred.
    //
    getActionWidths: function (jax,state) {
      if (!jax.root.SRE.actionWidths) {
        MathJax.OutputJax["HTML-CSS"].getMetrics(jax);
        try {this.computeActionWidths(jax.root)} catch (err) {
          if (!err.restart) throw err;
          return MathJax.Callback.After(["collapseState",this,state],err.restart);
        }
        state.changed = true;
      }
      return null;
    },
    //
    //  Compute the action widths by collapsing each
    //  maction, and recording the width of the complete equation
    //
    computeActionWidths: function (math) {
      var html = math.data[0].HTMLspanElement(), box = html.parentNode;
      math.SRE.width = box.bbox.w;
      var actions = math.SRE.action, j;
      for (j = actions.length-1; j >= 0; j--) actions[j].selection = 2;
      for (j = actions.length-1; j >= 0; j--) {
        var action = actions[j];
        if (action.SREwidth == null) {
          action.selection = 1;
          html = math.data[0].toHTML(box);
          action.SREwidth = html.bbox.w;
        }
      }
      math.SRE.actionWidths = true;
    },

    //
    //  Get the widths of the containers of tall the math elements
    //  that can be collapsed (so we can tell which ones NEED to be
    //  collapsed).  Do this in a way that only causes two reflows.
    //
    GetContainerWidths: function (element) {
      var JAX = MathJax.Hub.getAllJax(element);
      var i, m, script, span = MathJax.HTML.Element("span",{style:{display:"block"}});
      var math = [], jax, root;
      for (i = 0, m = JAX.length; i < m; i++) {
        jax = JAX[i], root = jax.root;
        if (root.SRE && root.SRE.action.length) {
          if (root.SRE.width == null) {
            root.SRE.cwidth = jax.HTMLCSS.cwidth;
            root.SRE.m = root.SRE.width = root.data[0].HTMLspanElement().parentNode.bbox.w;
            root.SRE.M = 1000000;
          }
          script = jax.SourceElement();
          script.previousSibling.style.display = "none";
          script.parentNode.insertBefore(span.cloneNode(false),script);
          math.push([jax,script]);
        }
      }
      for (i = 0, m = math.length; i < m; i++) {
        jax = math[i][0], script = math[i][1];
        if (script.previousSibling.offsetWidth)
          jax.root.SRE.cwidth = script.previousSibling.offsetWidth / jax.HTMLCSS.em /jax.HTMLCSS.scale;
      }
      for (i = 0, m = math.length; i < m; i++) {
        jax = math[i][0], script = math[i][1];
        script.parentNode.removeChild(script.previousSibling);
        script.previousSibling.style.display = "";
      }
    },

    /*****************************************************************/

    //
    //  Create a marker from a given string of characters
    //  (several possibilities are commented out)
    //
//    Marker: function (c) {return MML.mtext("\u25C3"+c+"\u25B9").With({mathcolor:"blue"})},
//    Marker: function (c) {return MML.mtext("\u25B9"+c+"\u25C3").With({mathcolor:"blue"})},
    Marker: function (c) {return MML.mtext("\u25C2"+c+"\u25B8").With({mathcolor:"blue"})},
//    Marker: function (c) {return MML.mtext("\u25B8"+c+"\u25C2").With({mathcolor:"blue"})},
//    Marker: function (c) {return MML.mtext("\u27EA"+c+"\u27EB").With({mathcolor:"blue"})},



    /*****************************************************************/

    //
    //  Make a collapsible element using maction that contains
    //  an appropriate marker, and the expanded MathML.
    //  If the MathML is a <math> node, make an mrow to use instead,
    //    and move the semantic data to it (I guess it would have been
    //    easier to have had that done initially, oh well).
    //
    MakeAction: function (collapse,mml) {
      var maction = MML.maction(collapse).With({
        actiontype:"toggle", complexity:collapse.getComplexity(), collapsible:true,
        attrNames: ["actiontype","complexity"], attr: {}, selection:2
      });
      if (mml.type === "math") {
        var mrow = MML.mrow().With({
          data: mml.data,
          complexity: mml.complexity,
          attrNames: [], attr: {}
        });
        mrow.attrNames.push("complexity");
        for (var i = mml.attrNames.length-1; i >= 0; i--) {
          var name = mml.attrNames[i];
          if (name.substr(0,14) === "data-semantic-") {
            mrow.attr[name] = mml.attr[name];
            mrow.attrNames.push(name);
            delete mml.attr[name];
            mml.attrNames.splice(i,1);
          }
        }
        mrow.complexity = mml.complexity; maction.Append(mrow); 
        mml.data = []; mml.Append(maction);
        mml.complexity = maction.complexity; maction = mml;
      } else {
        maction.Append(mml);
      }
      return maction;
    },

    /*****************************************************************/
    /*
     *  These routines are taken largely from the MathML input jax
     *  and convert the enriched MathML tree into the MathJax internal
     *  format, computing the complexity as we go, and collapsing
     *  the results when appropriate.
     */

    //
    //  Create an internal MathML element from the given DOM node
    //  (called recursively to handle the children)
    //  Get the complexity of the node, and collapse if appropriate
    //
    MakeMML: function (node) {
      var cls = String(node.getAttribute("class")||""); // make sure CLASS is a string
      var type = node.nodeName.toLowerCase().replace(/^[a-z]+:/,"");
      var mml, match = (cls.match(/(^| )MJX-TeXAtom-([^ ]*)/));
      if (match) mml = this.TeXAtom(match[2]); else mml = MML[type]();
      this.AddAttributes(mml,node); this.CheckClass(mml,mml["class"]);
      this.AddChildren(mml,node);
      mml.getComplexity();
      return mml.Collapse(node);
    },

    //
    //  Handle the special TeXAtom classes
    //
    TeXAtom: function (mclass) {
      var mml = MML.TeXAtom().With({texClass:MML.TEXCLASS[mclass]});
      if (mml.texClass === MML.TEXCLASS.OP) mml.movesupsub = mml.movablelimits = true;
      return mml;
    },

    //
    //  Handle special MathJax classes (for variants and TeXAtom elements)
    //
    CheckClass: function (mml,CLASS) {
      CLASS = (CLASS||"").split(/ /); var NCLASS = [];
      for (var i = 0, m = CLASS.length; i < m; i++) {
        if (CLASS[i].substr(0,4) === "MJX-") {
          if (CLASS[i] === "MJX-variant") mml.variantForm = true;
          if (CLASS[i].substr(0,11) !== "MJX-TeXAtom") mml.mathvariant = CLASS[i].substr(3);
        } else NCLASS.push(CLASS[i]);
      }
      if (NCLASS.length) mml["class"] = NCLASS.join(" "); else delete mml["class"];
    },

    //
    //  Convert attributes from the DOM elements to properties of the 
    //  internal MathML elements
    //
    AddAttributes: function (mml,node) {
      mml.attr = {}; mml.attrNames = [];
      for (var i = 0, m = node.attributes.length; i < m; i++) {
        var name = node.attributes[i].name;
        if (name == "xlink:href") name = "href";
        if (name.match(/:/)) continue;
        if (name.match(/^_moz-math-((column|row)(align|line)|font-style)$/)) continue;
        var value = node.attributes[i].value;
        var defaults = (mml.type === "mstyle" ? MML.math.prototype.defaults : mml.defaults);
        if (value != null) {
          if (value.toLowerCase() === "true") value = true;
            else if (value.toLowerCase() === "false") value = false;
          if (defaults[name] != null || MML.copyAttributes[name])
            {mml[name] = value} else {mml.attr[name] = value}
          mml.attrNames.push(name);
        }
      }
    },

    //
    //  Add the child nodes to the internal MathML structure
    //
    AddChildren: function (mml,node) {
      for (var i = 0, m = node.childNodes.length; i < m; i++) {
        var child = node.childNodes[i];
        if (child.nodeName === "#comment") continue;
        if (child.nodeName === "#text") {
          if ((mml.isToken || mml.isChars) && !mml.mmlSelfClosing) {
            mml.Append(MML.chars(child.textContent));
          }
        } else if (mml.type === "annotation-xml") {
          mml.Append(MML.xml(child));
        } else {
          mml.Append(this.MakeMML(child));
        }
      }
      if (mml.type === "mrow" && mml.data.length >= 2) {
        var first = mml.data[0], last = mml.data[mml.data.length-1];
        if (first.type === "mo" && first.Get("fence") &&
            last.type === "mo" && last.Get("fence")) {
          if (first.data[0]) mml.open = first.data.join("");
          if (last.data[0])  mml.close = last.data.join("");
        }
      }
    },

    /*****************************************************************/
    /*
     *  These routines implement the collapsing of the various semantic types
     */

    //
    //  If there is a specific routine for the type, do that, otherwise
    //  check if there is a complexity cut-off and marker for this type.
    //  If so, check if the complexity exceeds the cut off, and
    //    collapse using the appropriate marker for the type
    //  Return the (possibly modified) MathML
    //
    Collapse: function (node,mml) {
      var type = mml.attr["data-semantic-type"];
      if (type) {
        if (this["Collapse_"+type]) mml = (this["Collapse_"+type])(node,mml);
        else if (this.COLLAPSE[type] && this.MARKER[type]) {
          if (mml.complexity > this.COLLAPSE[type]) {
            var marker = this.MARKER[type];
            if (typeof(marker) !== "string")
              marker = marker[mml.attr["data-semantic-role"]] || marker.default;
            mml = this.MakeAction(this.Marker(marker),mml);
          }
        }
      }
      return mml;
    },

    UncollapseChild: function (mml,n,m) {
      if (m == null) m = 1;
      if (mml.attr["data-semantic-children"].split(/,/).length === m) {
        var child = (mml.data.length === 1 && mml.data[0].inferred ? mml.data[0] : mml);
        if (child && child.data[n] && child.data[n].collapsible) {
          child.SetData(n,child.data[n].data[1]);
          mml.complexity = child.complexity = null; mml.getComplexity();
          return 1;
        }
      }
      return 0
    },

    //
    //  For fenced elements, if the contents are collapsed,
    //    collapse the fence instead.
    //
    Collapse_fenced: function (node,mml) {
      this.UncollapseChild(mml,1);
      if (mml.complexity > this.COLLAPSE.fenced) {
        if (mml.attr["data-semantic-role"] === "leftright") {
          var marker = node.firstChild.textContent + node.lastChild.textContent;
          mml = this.MakeAction(this.Marker(marker),mml);
        }
      }
      return mml;
    },
    
    //
    //  Collapse function applications of the argument is collapsed
    //
    Collapse_appl: function (node,mml) {
      if (this.UncollapseChild(mml,2,2)) 
        mml = this.MakeAction(this.Marker(this.MARKER.appl),mml);
      return mml;
    },

    //
    //  For sqrt elements, if the contents are collapsed,
    //    collapse the sqrt instead.
    //
    Collapse_sqrt: function (node,mml) {
      this.UncollapseChild(mml,0);
      if (mml.complexity > this.COLLAPSE.sqrt)
        mml = this.MakeAction(this.Marker(this.MARKER.sqrt),mml);
      return mml;
    },
    Collapse_root: function (node,mml) {
      this.UncollapseChild(mml,0);
      if (mml.complexity > this.COLLAPSE.sqrt)
        mml = this.MakeAction(this.Marker(this.MARKER.sqrt),mml);
      return mml;
    },

    //
    //  For enclose, include enclosure in collapsed child, if any
    //
    Collapse_enclose: function (node,mml) {
      if (mml.attr["data-semantic-children"].split(/,/).length === 1) {
        var child = (mml.data.length === 1 && mml.data[0].inferred ? mml.data[0] : mml);
        if (child.data[0] && child.data[0].collapsible) {
          //
          //  Move menclose into the maction element
          //
          var maction = child.data[0];
          child.SetData(0,maction.data[1]);
          maction.SetData(1,mml);
          mml = maction;
        }
      }
      return mml;
    },

    //
    //  For bigops, get the character to use from the largeop at its core.
    //
    Collapse_bigop: function (node,mml) {
      if (mml.complexity > this.COLLAPSE.bigop || mml.data[0].type !== "mo") {
        var id = mml.attr["data-semantic-content"].split(/,/); id = id[id.length-1];
        var op = node.querySelector('*[data-semantic-id="'+id+'"]');
        mml = this.MakeAction(this.Marker(op.textContent),mml);
      }
      return mml;
    },
    
    Collapse_superscript: function (node,mml) {
      this.UncollapseChild(mml,0,2);
      if (mml.complexity > this.COLLAPSE.superscript)
        mml = this.MakeAction(this.Marker(this.MARKER.superscript),mml);
      return mml;
    },
    Collapse_subscript: function (node,mml) {
      this.UncollapseChild(mml,0,2);
      if (mml.complexity > this.COLLAPSE.subscript)
        mml = this.MakeAction(this.Marker(this.MARKER.subscript),mml);
      return mml;
    },
    Collapse_subsup: function (node,mml) {
      this.UncollapseChild(mml,0,3);
      if (mml.complexity > this.COLLAPSE.subsup)
        mml = this.MakeAction(this.Marker(this.MARKER.subsup),mml);
      return mml;
    }

    /*****************************************************************/

  };
  
  MathJax.Hub.processSectionDelay = 0;

  //
  //  Add a resize handler to check for math that needs
  //  to be collapsed or expanded.
  //
  MathJax.Hub.Register.StartupHook("HTML-CSS Jax Ready",function () {
    var timer = null, running = false, retry = false;
    var resizeAction = function () {
      timer = null;
      running = true;
      MathJax.Hub.Queue(
        ["CollapseWideMath",Collapse],
        function () {
          running = false;
          if (retry) {
            retry = false;
            setTimeout(resizeHandler,0);
          }
        }
      );
    };
    var resizeHandler = function (event) {
      if (running) {retry = true; return}
      if (timer) clearTimeout(timer);
      timer = setTimeout(resizeAction, 100);
    };
    window.addEventListener("resize",resizeHandler);
  });

  //
  //  Add the filter into the post-input hooks (priority 100, so other
  //  hooks run first, in particular, the enrichment hook).
  //
  MathJax.Hub.postInputHooks.Add(["Filter",Collapse],100);

  var COMPLEXITY = Collapse.COMPLEXITY;

  /*****************************************************************/
  /*
   *  Add Collapse() and getComplexity() methods to the internal
   *  MathML elements, and override these in the elements that need
   *  special handling.
   */

  MML.mbase.Augment({
    //
    //  Just call the Collapse() method from the extension by default
    //  (but can be overridden)
    //
    Collapse: function (node) {return Collapse.Collapse(node,this)},
    //
    //  If we don't have a cached complexity value,
    //    For token elements, just use the data length,
    //    Otherwise
    //      Add up the complexities of the children
    //      and add the child complexity based on the number of children
    //    Cache the complexity result
    //  return the complexity
    //
    getComplexity: function () {
      if (this.complexity == null) {
        var complexity = 0;
        if (this.isToken) {
          complexity = COMPLEXITY.TEXT * this.data.join("").length + COMPLEXITY.TOKEN;
        } else {
          for (var i = 0, m = this.data.length; i < m; i++)
            if (this.data[i]) complexity += this.data[i].getComplexity();
          if (m > 1) complexity += m * COMPLEXITY.CHILD;
        }
        if (this.attrNames && !("complexity" in this)) this.attrNames.push("complexity");
        this.complexity = complexity;
      }
      return this.complexity;
    }
  });

  //
  //  For fractions, scale the complexity of the parts, and add
  //  a complexity for fractions.
  //
  MML.mfrac.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        this.SUPER(arguments).getComplexity.call(this);
        this.complexity *= COMPLEXITY.SCRIPT;
        this.complexity += COMPLEXITY.FRACTION;
      }
      return this.complexity;
    }
  });
  
  //
  //  Square roots add extra complexity
  //
  MML.msqrt.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        this.SUPER(arguments).getComplexity.call(this);
        this.complexity += COMPLEXITY.SQRT;
      }
      return this.complexity;
    }
  });
  MML.mroot.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        this.SUPER(arguments).getComplexity.call(this);
        this.complexity -= (1-COMPLEXITY.SCRIPT) * this.data[1].getComplexity();
        this.complexity += COMPLEXITY.SQRT;
      }
      return this.complexity;
    }
  });
  
  //
  //  For msubsup, use the script complexity factor,
  //    take the maximum of the scripts,
  //    and add the sub-sup complexity
  //
  MML.msubsup.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        var C = 0;
        if (this.data[this.sub]) C = this.data[this.sub].getComplexity() + COMPLEXITY.CHILD;
        if (this.data[this.sup]) C = Math.max(this.data[this.sup].getComplexity(),C);
        C *= COMPLEXITY.SCRIPT;
        if (this.data[this.sub]) C += COMPLEXITY.CHILD;
        if (this.data[this.sup]) C += COMPLEXITY.CHILD;
        if (this.data[this.base]) C += this.data[this.base].getComplexity() + COMPLEXITY.CHILD;
        this.complexity = C + COMPLEXITY.SUBSUP;
        this.attrNames.push("complexity");
      }
      return this.complexity;
    }
  });

  //
  //  For munderover, use the script complexity factor,
  //    take the maximum of the scripts and the base,
  //    and add the under-over complexity
  //
  MML.munderover.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        var C = 0;
        if (this.data[this.sub]) C = this.data[this.sub].getComplexity() + COMPLEXITY.CHILD;
        if (this.data[this.sup]) C = Math.max(this.data[this.sup].getComplexity(),C);
        C *= COMPLEXITY.SCRIPT;
        if (this.data[this.base]) C = Math.max(this.data[this.base].getComplexity(),C);
        if (this.data[this.sub])  C += COMPLEXITY.CHILD;
        if (this.data[this.sup])  C += COMPLEXITY.CHILD;
        if (this.data[this.base]) C += COMPLEXITY.CHILD;
        this.complexity = C + COMPLEXITY.UNDEROVER;
        this.attrNames.push("complexity");
      }
      return this.complexity;
    }
  });
  
  //
  //  For mphantom, complexity is 0?
  //
  MML.mphantom.Augment({
    getComplexity: function () {
      if (this.complexity == null) this.attrNames.push("complexity");
      this.complexity = COMPLEXITY.PHANTOM;
      return this.complexity;
    }
  });
  
  //
  //  For ms, add width of quotes.  Don't cache the result, since
  //  mstyle above it could affect the result.
  //
  MML.ms.Augment({
    getComplexity: function () {
      this.SUPER(arguments).getComplexity.call(this);
      this.complexity += this.Get("lquote").length * COMPLEXITY.TEXT;
      this.complexity += this.Get("rquote").length * COMPLEXITY.TEXT;
      return this.complexity;
    }
  });

// ### FIXME:  getComplexity special cases: 
//             mtable, mfenced, mmultiscript

  //
  //  For menclose, complexity goes up by a fixed amount
  //
  MML.menclose.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        this.SUPER(arguments).getComplexity.call(this);
        this.complexity += COMPLEXITY.ACTION;
      }
      return this.complexity;
    }
  });

  //
  //  For maction, complexity is complexity of selected element
  //
  MML.maction.Augment({
    getComplexity: function () {
      //
      //  Don't cache it, since selection can change.
      //
      if (this.complexity == null) this.attrNames.push("complexity");
      this.complexity = (this.collapsible ? this.data[0] : this.selected()).getComplexity();
      return this.complexity;
    }
  });

  //
  //  For semantics, complexity is complexity of first child
  //
  MML.semantics.Augment({
    getComplexity: function () {
      if (this.complexity == null) {
        this.complexity = (this.data[0] ? this.data[0].getComplexity() : 0);
        this.attrNames.push("complexity");
      }
      return this.complexity;
    }
  });

  //
  //  Use fixed complexity, since we can't really measure it
  //
  MML["annotation-xml"].Augment({
    getComplexity: function () {
      this.complexity = COMPLEXITY.XML;
      return this.complexity;
    }
  });

  //
  //  Use fixed complexity, since we can't really measure it
  //
  MML.mglyph.Augment({
    getComplexity: function () {
      this.complexity = COMPLEXITY.GLYPH;
      return this.complexity;
    }
  });

});
