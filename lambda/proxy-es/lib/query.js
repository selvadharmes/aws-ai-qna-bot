//start connection
var _=require('lodash');
var request=require('./request');
var build_es_query=require('./esbodybuilder');
var handlebars=require('./handlebars');
var translate = require('./translate');


async function run_query(req, query_params){
    var es_query = await build_es_query(query_params);
    var es_response = await request({
        url:`https://${req._info.es.address}/${req._info.es.index}/${req._info.es.type}/_search?search_type=dfs_query_then_fetch`,
        method:"GET",
        body:es_query
    });
    return es_response;
}

function merge_next(hit1, hit2){
    console.log("Merge chained items");
    // merge plaintext answer
    hit2.a = hit1.a + hit2.a;
    // merge markdown, if present in both items
    var md1 = (_.get(hit1,"alt.markdown"));
    var md2 = (_.get(hit2,"alt.markdown"));
    if (md1 && md2){
       _.set(hit2,"alt.markdown", md1 + "\n" + md2); 
    } else {
        console.log("Markdown field missing from one or both items; skip markdown merge");
    }
    // merge SSML, if present in both items
    var ssml1 = (_.get(hit1,"alt.ssml"));
    var ssml2 = (_.get(hit2,"alt.ssml"));
    if (ssml1 && ssml2){
        // strip <speak> tags
        ssml1 = ssml1.replace(/<speak>|<\/speak>/g,"");
        ssml2 = ssml2.replace(/<speak>|<\/speak>/g,"");
        // concatenate, and re-wrap with <speak> tags
        _.set(hit2,"alt.ssml", "<speak>" + ssml1 + " " + ssml2 + "</speak>");                
    } else {
        console.log("SSML field missing from one or both items; skip SSML merge");
    }
    // all other fields inherited from item 2
    console.log("Chained items merged:", hit2);
    return hit2;
}

async function get_hit(req, res){
    var query_params = {
        question: req.question,
        topic: _.get(req,'session.topic',''),
        from: 0,
        size: 1,
        minimum_should_match: _.get(req,'_settings.ES_MINIMUM_SHOULD_MATCH'),
        use_keyword_filters: _.get(req,'_settings.ES_USE_KEYWORD_FILTERS'),
        keyword_syntax_types: _.get(req,'_settings.ES_KEYWORD_SYNTAX_TYPES'),
        syntax_confidence_limit: _.get(req,'_settings.ES_SYNTAX_CONFIDENCE_LIMIT'),
    };
    var no_hits_question = _.get(req,'_settings.ES_NO_HITS_QUESTION','no_hits');
    var response = await run_query(req, query_params);
    console.log("Query response: ", response);
    var hit = _.get(response,"hits.hits[0]._source");
    if (hit){
        res['got_hits']=1;  // response flag, used in logging / kibana
    } else {
        console.log("No hits from query - searching instead for: " + no_hits_question);
        query_params['question'] = no_hits_question;
        res['got_hits']=0;  // response flag, used in logging / kibana
        response = await run_query(req, query_params);
        hit = _.get(response,"hits.hits[0]._source");
    }
    // Do we have a hit?
    if (hit) {
        // set res topic from document before running handlebars, so that handlebars cann access or overwrite it.
        _.set(res,"session.topic", _.get(hit,"t"));
        // run handlebars template processing
        hit=await handlebars(req,res,hit);        
    }
    return hit;
}

module.exports=async function(req,res){
    console.log("REQ:",JSON.stringify(req,null,2));
    console.log("RES:",JSON.stringify(res,null,2));
    var hit = await get_hit(req, res) ;
    console.log("hit from query:"+JSON.stringify(hit,null,2));
    if(hit){
        // evaluate conditionalChaining
        if (_.get(hit,"conditionalChaining")){
            console.log("Chained document rule specified:", hit.conditionalChaining);
            // provide 'SessionAttributes' var to chaining rule, consistent with Handlebars context
            const SessionAttributes = res.session ;
            // evaluate conditionalChaining expression.. throws an exception if there is a syntax error
            const next_q = eval(hit.conditionalChaining); 
            console.log("Chained document rule evaluated to:", next_q);
            req.question = next_q;
            var hit2 = await get_hit(req, res) ;
            if (hit2) {
                hit = merge_next(hit, hit2);
            } else {
                console.log("WARNING: No documents found for evaluated chaining rule:", next_q);
            }
        }
        if (req._settings.ENABLE_MULTI_LANGUAGE_SUPPORT){
            const usrLang = _.get(req, 'session.userLocale');
            if (usrLang != 'en') {
                console.log("Autotranslate hit to usrLang: ", usrLang);
                hit=await translate.translate_hit(hit,usrLang);
            } else {
                console.log("User Lang is en, Autotranslate not required.");
            }
        }
        res.result = hit;
        res.type="PlainText"
        res.message=res.result.a
        res.plainMessage=res.result.a
        
        _.set(res,"session.appContext.altMessages",
            _.get(res,"result.alt",{})
        )

        if(req._event.outputDialogMode!=="Text"){
            if(_.get(res,"result.alt.ssml")){
                res.type="SSML"
                res.message=res.result.alt.ssml.replace(/\r?\n|\r/g,' ')
            }
        }
        console.log(res.message)
        var card=_.get(res,"result.r.title") ? res.result.r : null
        
        if(card){
            res.card.send=true
            res.card.title=_.get(card,'title')
            res.card.subTitle=_.get(card,'subTitle')
            res.card.imageUrl=_.get(card,'imageUrl')
            res.card.buttons=_.get(card,'buttons')
        }

        
        var navigationJson = _.get(res,"session.navigation",false)
        var previousQid = _.get(res,"session.previous.qid",false)
        var previousArray  = _.get(res,"session.navigation.previous",[])
        
        if(
            previousQid != _.get(res.result,"qid") && 
            _.get(navigationJson,"hasParent",true) == false && 
            req._info.es.type=='qna')
        {
            if(previousArray.length == 0){
                previousArray.push(previousQid)
            }
            else if(previousArray[previousArray.length -1] != previousQid){
                previousArray.push(previousQid)
            }
            
        }
        if(previousArray.length > 10){
            previousArray.shift()
        }
        var hasParent = true
        if("next" in res.result){
            hasParent = false
        }
        res.session.previous={    
            qid:_.get(res.result,"qid"),
            a:_.get(res.result,"a"),
            alt:_.get(res.result,"alt",{}),
            q:req.question
        }
        res.session.navigation={
            next:_.get(res.result,
                "next",
                _.get(res,"session.navigation.next","")
            ),
            previous:previousArray,
            hasParent:hasParent
        }
    }else{
        res.type="PlainText"
        res.message=_.get(req,'_settings.EMPTYMESSAGE','You stumped me!');
    }
    console.log("RESULT",JSON.stringify(req),JSON.stringify(res))

}

